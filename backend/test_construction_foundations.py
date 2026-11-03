"""Construction phase 1 - make it safe and usable (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr, fix/construction-foundations).

What these pin, end to end through the API:
  1. Company walls: a job belongs to a company; a manager in another company
     never sees, reviews or edits it (404, never 403); an untagged job is for
     unwalled callers only; the people on a job keep their reach.
  2. Media links: only this job's own objects in construction-media are
     accepted (and fetched), never a stranger's URL, another bucket or
     another job's folder; submittal documents the same.
  3. Evidence: a photo on a submitted / approved / reported log stays; a draft's
     uploader may remove theirs, a manager only with a reason; removed photos
     never print; someone else's draft and its photos are private.
  4. Review follows the log's state: never a draft, never your own, never an
     approved log without an explicit Reopen (manager, reason, on the record).
  5. Contract value only for those who may see it.
  6. The geofence check runs whenever GPS arrives.
  8. AI off: nothing queued, ready for review at once; stale AI jobs skipped.
 10. The week rule: the project's week, on the jobsite's clock; a published
     week stays visible until its new version is published.
 11. One bell per workflow, and reviewers when a job names none.
 12. Report emails are escaped.
 15. The health row.

One throwaway SQLite. Run with: python -m pytest test_construction_foundations.py -q
"""
import os
import tempfile
import unittest
from datetime import date, datetime, timezone
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["SUPABASE_URL"] = "https://proj.supabase.co"
os.environ["SUPABASE_SERVICE_KEY"] = "service-key"
os.environ.pop("ANTHROPIC_API_KEY", None)

from fastapi.testclient import TestClient   # noqa: E402

import auth                   # noqa: E402
import cache                  # noqa: E402
import construction_company   # noqa: E402
import construction_health    # noqa: E402
import construction_notify    # noqa: E402
import construction_worker    # noqa: E402
import database               # noqa: E402
import main                   # noqa: E402
import models                 # noqa: E402

PUB = "https://proj.supabase.co/storage/v1/object/public"
A, B = "co-a", "co-b"
MGR_A = "mgr.a@greensglobal.com"       # manager by role, company A
MGR_A2 = "mgr.a2@greensglobal.com"     # a second manager in company A
MGR_B = "mgr.b@greensglobal.com"       # manager by role, company B
CREW = "crew@greensglobal.com"         # employee, company A, on job A's crew
CREW2 = "crew2@greensglobal.com"       # employee, company A, on job A's crew
EXEC = "investor@outside.example"


def _iso():
    return datetime.now(timezone.utc).isoformat()


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except OSError:
            pass

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self.db = database.SessionLocal()
        for m in (models.NexusRole, models.NexusEmployee, models.HrEntity, models.NexusSetting,
                  models.ConstructionProject, models.ConstructionDailyLog, models.ConstructionMedia,
                  models.ConstructionAIJob, models.ConstructionWeeklyReport, models.ConstructionActivity,
                  models.ConstructionRfi, models.ConstructionMilestone, models.ConstructionSubmittal,
                  models.NexusNotification, models.PropertyAsset):
            self.db.query(m).delete()
        for em, co in ((MGR_A, A), (MGR_A2, A), (MGR_B, B), (CREW, A), (CREW2, A)):
            self.db.add(models.NexusEmployee(id=f"e-{em}", first_name=em.split("@")[0].split(".")[0].title(),
                                             last_name="Person", work_email=em, status="active", deleted_at="",
                                             company=co))
        for em in (MGR_A, MGR_A2, MGR_B):
            self.db.add(models.NexusRole(email=em, role="manager", assigned_by="test"))
        self.db.add(models.HrEntity(id=A, name="Greens Build"))
        self.db.add(models.HrEntity(id=B, name="Greens Books"))
        # The walls are armed: levels 1-3 are confined to their companies.
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.add(self._project("pa", "Job A", A, workers=[CREW, CREW2]))
        self.db.add(self._project("pb", "Job B", B, managers=[MGR_B]))
        self.db.add(self._project("pz", "Untagged Job", ""))
        self.db.commit()
        cache.settings_config.invalidate()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def tearDown(self):
        self.db.rollback()
        self.db.close()
        auth.SKIP_AUTH = self._skip
        auth.invalidate_role_cache()
        cache.settings_config.invalidate()

    @staticmethod
    def _project(pid, name, company, managers=(), workers=(), **kw):
        return models.ConstructionProject(
            id=pid, name=name, company_id=company, status="active", archived=False, deleted_at="",
            manager_emails=list(managers), worker_emails=list(workers), executive_emails=[EXEC],
            week_starts_on=1, report_day=5, created_at=_iso(), modified_at=_iso(),
            time_zone="America/Los_Angeles", **kw)

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _log(self, lid="l1", pid="pa", author=CREW, status="submitted", day="2026-11-02"):
        self.db.add(models.ConstructionDailyLog(
            id=lid, project_id=pid, log_date=day, author_email=author, status=status, notes_raw="Poured footings",
            created_at=_iso(), modified_at=_iso(), deleted_at=""))
        self.db.commit()

    def _photo(self, mid="m1", lid="l1", pid="pa", by=CREW):
        self.db.add(models.ConstructionMedia(
            id=mid, project_id=pid, daily_log_id=lid, kind="photo", mime_type="image/jpeg",
            url=f"{PUB}/construction-media/construction/{pid}/{mid}.jpg", storage_path=f"construction/{pid}/{mid}.jpg",
            uploaded_by=by, uploaded_at=_iso(), deleted_at="", duplicate_of=""))
        self.db.commit()


class CompanyWallTests(_Base):
    def test_a_manager_sees_only_their_companys_jobs(self):
        self._as(MGR_A)
        names = sorted(p["name"] for p in self.client.get("/construction/projects").json())
        self.assertEqual(names, ["Job A"])
        self.assertEqual([p["name"] for p in self.client.get("/construction/overview").json()["projects"]], ["Job A"])

    def test_another_companys_job_is_a_404_everywhere(self):
        self._as(MGR_A)
        self._log("lb", "pb", author=MGR_B)
        for path in ("/construction/projects/pb", "/construction/projects/pb/logs",
                     "/construction/projects/pb/reports", "/construction/projects/pb/register/rfis"):
            self.assertEqual(self.client.get(path).status_code, 404, path)
        self.assertEqual(self.client.patch("/construction/projects/pb", json={"name": "Mine"}).status_code, 404)
        self.assertEqual(self.client.post("/construction/logs/lb/review", json={"decision": "approve"}).status_code, 404)
        self.assertEqual(self.client.get("/construction/logs/lb/media").status_code, 404)
        self.assertEqual(self.client.post("/construction/projects/pb/reports/generate", json={}).status_code, 404)
        self.assertEqual(self.client.get("/construction/review-queue").json(), [])

    def test_an_untagged_job_is_only_for_unwalled_callers(self):
        self._as(MGR_A)
        self.assertEqual(self.client.get("/construction/projects/pz").status_code, 404)
        # Walls off: a manager reads every job again, the untagged one included.
        self.db.query(models.NexusSetting).filter(models.NexusSetting.key == "company_walls").delete()
        self.db.commit()
        cache.settings_config.invalidate()
        self.assertEqual(self.client.get("/construction/projects/pz").status_code, 200)

    def test_the_people_on_a_job_keep_their_reach(self):
        self._as(CREW)
        self.assertEqual([p["name"] for p in self.client.get("/construction/projects").json()], ["Job A"])
        self.assertEqual(self.client.get("/construction/projects/pb").status_code, 404)

    def test_a_new_job_lands_in_its_creators_company(self):
        self._as(MGR_A)
        with mock.patch("construction_weather.geocode", return_value=False):
            r = self.client.post("/construction/projects", json={"name": "Job A2", "address": "1 Main St"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["companyId"], A)
        self._as(MGR_B)
        self.assertNotIn("Job A2", [p["name"] for p in self.client.get("/construction/projects").json()])

    def test_a_walled_manager_cannot_put_another_companys_people_on_a_job(self):
        self._as(MGR_A)
        r = self.client.patch("/construction/projects/pa", json={"worker_emails": [CREW, MGR_B]})
        self.assertEqual(r.status_code, 422)
        self.assertIn(MGR_B, r.json()["detail"])

    def test_backfill_prefers_the_property_runs_once_and_logs_each_placement(self):
        """Review M3: the property's entity wins over the creator's company; a
        name two companies share places nothing; every placement is on the
        job's activity log; the pass runs once; a dry run writes nothing."""
        self.db.add(models.HrEntity(id="co-c", name="Shared Name"))
        self.db.add(models.HrEntity(id="co-d", name="Other", legal_name="shared name"))
        self.db.add(models.PropertyAsset(id="prop1", name="Harbor", payload={"entity": "greens build"}))
        self.db.add(models.PropertyAsset(id="prop2", name="Bay", payload={"entity": "Shared Name"}))
        self.db.add(self._project("old1", "Old By Creator", "", created_by=MGR_B))
        self.db.add(self._project("old2", "Property Beats Creator", "", property_id="prop1", created_by=MGR_B))
        self.db.add(self._project("old3", "Ambiguous Entity", "", property_id="prop2", created_by="system"))
        self.db.commit()
        plan = construction_company.dry_run(self.db)
        self.assertEqual({i["projectId"]: (i["companyId"], i["source"]) for i in plan["place"]},
                         {"old1": (B, "creator"), "old2": (A, "property")})
        self.assertEqual(sorted(i["projectId"] for i in plan["unplaced"]), ["old3", "pz"])
        self.assertEqual(self.db.get(models.ConstructionProject, "old1").company_id, "")   # dry run wrote nothing
        self.assertEqual(construction_company.backfill(self.db), 2)
        got = {p.id: p.company_id for p in self.db.query(models.ConstructionProject).all()}
        self.assertEqual((got["old1"], got["old2"], got["old3"], got["pz"]), (B, A, "", ""))
        acts = {a.project_id: a.detail for a in self.db.query(models.ConstructionActivity)
                .filter(models.ConstructionActivity.type == "company_placed").all()}
        self.assertEqual(acts["old2"], "placed in Greens Build (from the property)")
        self.assertEqual(set(acts), {"old1", "old2"})
        self.db.add(self._project("old4", "Later", "", created_by=MGR_A))
        self.db.commit()
        self.assertIsNone(construction_company.backfill(self.db))       # once - the mark
        self.assertEqual(self.db.get(models.ConstructionProject, "old4").company_id, "")

    def test_insights_are_cached_per_company_wall_never_shared(self):
        """Review M1: the board's cache key was () for everyone, so the first
        viewer's company counts leaked to the next for 20 s."""
        self.db.add(self._project("pb2", "Job B2", B, managers=[MGR_B]))
        self.db.commit()
        cache.dashboard_insights.invalidate()

        def active(who):
            self._as(who)
            mods = {m["id"]: m for m in self.client.get("/dashboards/insights").json()["modules"]}
            return {s["key"]: s["value"] for s in mods["construction"]["stats"]}["active_projects"]
        self.assertEqual((active(MGR_A), active(MGR_B), active(MGR_A)), (1, 2, 1))
        cache.dashboard_insights.invalidate()

    def test_the_approvals_inbox_and_insights_respect_the_wall(self):
        import approvals_inbox
        from routers import dashboards
        self._log("lb", "pb", author=MGR_B)
        self._log("la", "pa", author=CREW)
        user = {"email": MGR_A, "level": 3}
        rows = [r for r in approvals_inbox.collect(self.db, user, only={"construction_log_review"})["rows"]]
        # Job A's log waits on him (a company manager - Job A names none);
        # Job B's never does.
        self.assertEqual([r["key"] for r in rows], ["construction_log_review:la"])
        self.assertEqual(rows[0]["link"], {"view": "ops", "sub": "activity:pa"})
        self.assertEqual(dashboards._construction_pids(self.db, auth.company_scope(user, self.db)), ["pa"])


class MediaLinkTests(_Base):
    def setUp(self):
        super().setUp()
        self._log("l1", status="draft")
        self._as(CREW)

    def _media(self, url, storage_path="", thumb=""):
        return self.client.post("/construction/logs/l1/media", json={
            "kind": "photo", "mime_type": "image/jpeg", "size_bytes": 1000, "url": url,
            "storage_path": storage_path, "thumbnail_url": thumb})

    def test_only_this_jobs_own_objects_are_accepted(self):
        good = f"{PUB}/construction-media/construction/pa/abc.jpg"
        r = self._media(good, "construction/pa/abc.jpg")
        self.assertEqual(r.status_code, 201, r.text)
        row = self.db.query(models.ConstructionMedia).filter(models.ConstructionMedia.id == r.json()["id"]).first()
        self.assertEqual(row.storage_path, "construction/pa/abc.jpg")
        for bad in ("https://example.com/x.jpg", "http://169.254.169.254/latest/meta-data",
                    f"{PUB}/task-files/secret.pdf", f"{PUB}/construction-media/construction/pb/abc.jpg",
                    f"{PUB}/construction-media/construction/pa/../pb/abc.jpg",
                    "data:image/png;base64,AAAA"):
            self.assertEqual(self._media(bad).status_code, 422, bad)
        self.assertEqual(self._media(good, "construction/pb/abc.jpg").status_code, 422)
        self.assertEqual(self._media(good, "", "https://example.com/t.jpg").status_code, 422)

    def test_submittal_documents_are_this_jobs_files_only(self):
        self._as(MGR_A)
        r = self.client.post("/construction/projects/pa/register/submittals",
                             json={"title": "Rebar shop drawings", "document_urls": ["https://example.com/x.pdf"]})
        self.assertEqual(r.status_code, 422)
        r = self.client.post("/construction/projects/pa/register/submittals",
                             json={"title": "Rebar shop drawings",
                                   "document_urls": [f"{PUB}/construction-media/construction/pa/doc.pdf"]})
        self.assertEqual(r.status_code, 201, r.text)

    def test_server_side_fetches_refuse_anything_else(self):
        from services import construction_storage as storage
        m = models.ConstructionMedia(id="x", project_id="pa", url="https://example.com/x.jpg", storage_path="construction/pa/x.jpg")
        with self.assertRaises(ValueError):
            storage.fetch_url(m)
        m.url = f"{PUB}/construction-media/construction/pb/x.jpg"
        with self.assertRaises(ValueError):
            storage.fetch_url(m)
        # The thumbnail job never writes outside the job's own folder.
        m.url, m.storage_path, m.kind, m.mime_type = f"{PUB}/construction-media/construction/pa/x.jpg", "../pb/x.jpg", "photo", "image/jpeg"
        with self.assertRaises(ValueError):
            construction_worker._derive_thumbnail(self.db, m)


class EvidenceTests(_Base):
    def test_a_photo_on_a_submitted_or_approved_log_stays(self):
        for status in ("submitted", "processed", "approved"):
            self.db.query(models.ConstructionMedia).delete()
            self.db.query(models.ConstructionDailyLog).delete()
            self.db.commit()
            self._log("l1", status=status)
            self._photo()
            for who in (CREW, MGR_A):
                self._as(who)
                r = self.client.delete("/construction/media/m1", params={"reason": "blurry"})
                self.assertEqual(r.status_code, 409, (status, who))

    def test_a_drafts_uploader_may_remove_and_a_manager_needs_a_reason(self):
        self._log("l1", status="draft")
        self._photo("m1")
        self._photo("m2")
        self._as(CREW)
        self.assertEqual(self.client.delete("/construction/media/m1").status_code, 204)
        self._as(MGR_A)
        self.assertEqual(self.client.delete("/construction/media/m2").status_code, 422)
        self.assertEqual(self.client.delete("/construction/media/m2", params={"reason": "Wrong jobsite"}).status_code, 204)
        rows = {m.id: m.deleted_at for m in self.db.query(models.ConstructionMedia).all()}
        self.assertTrue(rows["m1"] and rows["m2"])     # soft: the rows are still there
        act = self.db.query(models.ConstructionActivity).filter(models.ConstructionActivity.entity_id == "m2").first()
        self.assertEqual(act.detail, "Wrong jobsite")

    def test_a_photo_in_a_published_report_stays_even_on_a_reopened_draft(self):
        self._log("l1", status="needs_info")
        self._photo()
        self.db.add(models.ConstructionWeeklyReport(id="r1", project_id="pa", week_start="2026-11-02", status="published",
                                                    media_ids=["m1"], version=1, deleted_at=""))
        self.db.commit()
        self._as(CREW)
        self.assertEqual(self.client.delete("/construction/media/m1").status_code, 409)

    def test_someone_elses_draft_and_its_photos_are_private(self):
        self._log("l1", author=CREW, status="draft")
        self._photo()
        self._as(CREW2)
        self.assertEqual([l["id"] for l in self.client.get("/construction/projects/pa/logs").json()], [])
        self.assertEqual(self.client.get("/construction/logs/l1/media").status_code, 404)
        self._as(CREW)
        self.assertEqual(len(self.client.get("/construction/logs/l1/media").json()), 1)

    def test_a_removed_photo_never_prints(self):
        import construction_pdf
        r = models.ConstructionWeeklyReport(id="r1", project_id="pa", week_start="2026-11-02", media_ids=["m1"],
                                            sections={}, section_order=[], title="Week")
        p = self.db.get(models.ConstructionProject, "pa")
        gone = models.ConstructionMedia(id="m1", project_id="pa", kind="photo", url="https://example.com/x.jpg",
                                        deleted_at=_iso())
        with mock.patch.object(construction_pdf, "_fetch", side_effect=AssertionError("fetched a removed photo")):
            pdf = construction_pdf.build(r, p, {"m1": gone}, [])
        self.assertTrue(pdf.startswith(b"%PDF"))


class ReviewTests(_Base):
    def test_review_follows_the_logs_state(self):
        self._log("d1", status="draft")
        self._log("own", author=MGR_A, status="submitted")
        self._log("l1", status="submitted")
        self._as(MGR_A)
        self.assertEqual(self.client.post("/construction/logs/d1/review", json={"decision": "approve"}).status_code, 409)
        self.assertEqual(self.client.post("/construction/logs/own/review", json={"decision": "approve"}).status_code, 403)
        self.assertEqual(self.client.post("/construction/logs/l1/review", json={"decision": "needs_info"}).status_code, 422)
        r = self.client.post("/construction/logs/l1/review", json={"decision": "approve"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.client.post("/construction/logs/l1/review", json={"decision": "needs_info", "note": "x"}).status_code, 409)
        self.assertNotIn("own", [l["id"] for l in self.client.get("/construction/review-queue").json()])

    def test_reopen_is_a_managers_act_with_a_reason_on_the_record(self):
        self._log("l1", status="approved")
        self._as(CREW2)
        self.assertEqual(self.client.post("/construction/logs/l1/reopen", json={"reason": "x"}).status_code, 403)
        self._as(MGR_A)
        self.assertEqual(self.client.post("/construction/logs/l1/reopen", json={}).status_code, 422)
        r = self.client.post("/construction/logs/l1/reopen", json={"reason": "Wrong crew count"})
        self.assertEqual((r.status_code, r.json()["status"]), (200, "submitted"))
        act = (self.db.query(models.ConstructionActivity)
               .filter(models.ConstructionActivity.entity_id == "l1", models.ConstructionActivity.type == "reopened").first())
        self.assertEqual(act.detail, "Wrong crew count")
        self.assertEqual(self.client.post("/construction/logs/l1/review", json={"decision": "approve"}).status_code, 200)


class ProjectEditTests(_Base):
    def test_contract_value_only_for_those_who_may_see_it(self):
        self.db.query(models.ConstructionProject).filter(models.ConstructionProject.id == "pa").update({"contract_value": 1240000.0})
        self.db.commit()
        self._as(CREW)
        self.assertNotIn("contractValue", self.client.get("/construction/projects").json()[0])
        self.assertEqual(self.client.patch("/construction/projects/pa", json={"contract_value": 1}).status_code, 403)
        self._as(MGR_A)
        p = self.client.get("/construction/projects/pa").json()
        self.assertEqual(p["contractValue"], 1240000.0)
        self.assertTrue(p["canEdit"])

    def test_the_edit_job_sheet_saves_status_team_and_dates(self):
        self._as(MGR_A)
        r = self.client.patch("/construction/projects/pa", json={
            "status": "on_hold", "phase": "Framing", "percent_complete": 42, "start_on": "2026-06-01",
            "target_finish_on": "2026-12-15", "manager_emails": [MGR_A2], "worker_emails": [CREW]})
        self.assertEqual(r.status_code, 200, r.text)
        j = r.json()
        self.assertEqual((j["status"], j["phase"], j["percentComplete"], j["managerEmails"], j["workerEmails"]),
                         ("on_hold", "Framing", 42.0, [MGR_A2], [CREW]))
        for bad in ({"status": "paused"}, {"percent_complete": 140}, {"start_on": "11/01/2026"},
                    {"start_on": "2026-12-20", "target_finish_on": "2026-12-01"}):
            self.assertEqual(self.client.patch("/construction/projects/pa", json=bad).status_code, 422, bad)


class ReviewFollowUpTests(_Base):
    """The code review of 11/03/2026 (M2, M4, M5, L6, L8, L9, L10)."""

    def test_a_sent_back_log_keeps_its_photos_from_the_uploader(self):
        """M2: approve -> Reopen -> Send Back must not let the uploader remove
        evidence a reviewer already saw; a manager may, with a reason."""
        self._log("l1", status="needs_info")
        self.db.query(models.ConstructionDailyLog).filter(models.ConstructionDailyLog.id == "l1").update(
            {"submitted_at": _iso()})
        self.db.commit()
        self._photo()
        self._as(CREW)
        self.assertEqual(self.client.delete("/construction/media/m1").status_code, 403)
        self._as(MGR_A)
        self.assertEqual(self.client.delete("/construction/media/m1").status_code, 422)
        self.assertEqual(self.client.delete("/construction/media/m1", params={"reason": "Duplicate shot"}).status_code, 204)
        # A draft that was submitted once and reopened to draft is the same.
        self._log("l2", status="draft")
        self.db.query(models.ConstructionDailyLog).filter(models.ConstructionDailyLog.id == "l2").update(
            {"submitted_at": _iso()})
        self.db.commit()
        self._photo("m2", "l2")
        self._as(CREW)
        self.assertEqual(self.client.delete("/construction/media/m2").status_code, 403)

    def test_a_decision_on_a_log_that_moved_meanwhile_is_refused(self):
        """M4: the state check and the change are one conditional UPDATE - a
        second manager acting on a stale copy gets 409, never a second decision."""
        from fastapi import HTTPException
        from routers import construction as C
        self._log("l1", status="submitted")
        stale = self.db.get(models.ConstructionDailyLog, "l1")
        other = database.SessionLocal()
        other.query(models.ConstructionDailyLog).filter(models.ConstructionDailyLog.id == "l1").update({"status": "approved"})
        other.commit()
        other.close()
        with self.assertRaises(HTTPException) as e:
            C._claim(self.db, stale, C.REVIEWABLE, status="needs_info")
        self.assertEqual(e.exception.status_code, 409)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.ConstructionDailyLog, "l1").status, "approved")

    def test_a_report_only_keeps_and_prints_its_own_jobs_photos(self):
        """M5: media ids from another job never get into a report."""
        self._log("l1", status="approved")
        self._photo("ma", "l1", "pa")
        self._log("lb", "pb", author=MGR_B, status="approved")
        self._photo("mb", "lb", "pb", by=MGR_B)
        self.db.add(models.ConstructionWeeklyReport(id="r1", project_id="pa", week_start="2026-11-02", status="draft",
                                                    version=1, media_ids=[], sections={}, section_order=[], deleted_at=""))
        self.db.commit()
        self._as(MGR_A)
        r = self.client.patch("/construction/reports/r1", json={"media_ids": ["mb", "ma", "nope"]})
        self.assertEqual(r.json()["mediaIds"], ["ma"])
        # A row written before this (or by hand) still never prints another job's photo.
        self.db.query(models.ConstructionWeeklyReport).filter(models.ConstructionWeeklyReport.id == "r1").update(
            {"media_ids": ["ma", "mb"]}, synchronize_session=False)
        self.db.commit()
        import construction_pdf
        seen = {}
        with mock.patch.object(construction_pdf, "build", side_effect=lambda r, p, media, logs: seen.update(media) or b"%PDF"):
            self.assertEqual(self.client.get("/construction/reports/r1/pdf").status_code, 200)
        self.assertEqual(sorted(seen), ["ma"])

    def test_an_executive_who_is_a_nexus_person_passes_the_wall_an_outsider_is_allowed(self):
        """L6."""
        self._as(MGR_A)
        r = self.client.patch("/construction/projects/pa", json={"executive_emails": [EXEC, MGR_B]})
        self.assertEqual(r.status_code, 422)
        r = self.client.patch("/construction/projects/pa", json={"executive_emails": [EXEC, "owner@outside.example", MGR_A2]})
        self.assertEqual(r.status_code, 200, r.text)

    def test_a_project_with_no_week_start_keeps_the_schedulers_old_sunday(self):
        """L8: NULL week_starts_on read as Sunday (0), as the scheduler always
        did - never Monday, which would cut a second draft for the same days."""
        p = self.db.get(models.ConstructionProject, "pa")
        p.week_starts_on = None
        now = datetime(2026, 11, 6, 20, 0, tzinfo=timezone.utc)   # Friday 11/06 on site
        self.assertEqual(construction_company.current_week_start(self.db, p, now), date(2026, 11, 1))
        import construction_worker as W
        self.assertEqual(W.week_start_for(date(2026, 11, 6), construction_company.week_starts(p)), date(2026, 11, 1))

    def test_one_report_per_project_week_and_version(self):
        """L9: the unique index, and the next version passes removed rows."""
        from sqlalchemy.exc import IntegrityError
        self.db.add(models.ConstructionWeeklyReport(id="x1", project_id="pa", week_start="2026-10-26", version=1,
                                                    status="draft", deleted_at=_iso()))
        self.db.commit()
        self.db.add(models.ConstructionWeeklyReport(id="x2", project_id="pa", week_start="2026-10-26", version=1,
                                                    status="draft", deleted_at=""))
        with self.assertRaises(IntegrityError):
            self.db.commit()
        self.db.rollback()
        self._as(MGR_A)
        r = self.client.post("/construction/projects/pa/reports/generate", json={"week_start": "2026-10-26"})
        self.assertEqual((r.status_code, r.json()["version"]), (201, 2))

    def test_the_scheduler_skips_a_week_another_worker_just_cut(self):
        """L9: an IntegrityError from the unique index is someone else's draft."""
        import construction_report
        import construction_worker as W
        from sqlalchemy.exc import IntegrityError

        def racing(db, project, week_start, actor, **kw):
            raise IntegrityError("insert", {}, Exception("duplicate"))
        with mock.patch.object(construction_report, "generate", side_effect=racing):
            counts = W.cut_due_drafts(today=date(2026, 11, 6))
        self.assertEqual((counts["cut"], counts["failed"]), (0, 0))
        self.assertGreaterEqual(counts["skipped"], 1)

    def test_a_bell_fired_twice_for_one_workflow_is_one_row(self):
        """L10 (the lock itself is Postgres-only; here the in-place rewrite)."""
        for title in ("First", "Second"):
            construction_notify.bell(self.db, kind="log_submitted", recipient=MGR_A, title=title, body="b",
                                     ref_id="l9", family=construction_notify.LOG_KINDS)
        self.db.commit()
        rows = self.db.query(models.NexusNotification).filter(models.NexusNotification.ref_id == "l9").all()
        self.assertEqual([r.title for r in rows], ["Second"])


class GeofenceTests(_Base):
    def test_gps_on_a_later_save_is_checked(self):
        self.db.query(models.ConstructionProject).filter(models.ConstructionProject.id == "pa").update(
            {"latitude": 33.5, "longitude": -117.15, "geofence_radius_m": 500})
        self.db.commit()
        self._log("l1", status="draft")
        self._as(CREW)
        r = self.client.patch("/construction/logs/l1", json={"gps_latitude": 34.5, "gps_longitude": -117.15})
        self.assertFalse(r.json()["geofenceOk"])
        r = self.client.patch("/construction/logs/l1", json={"gps_latitude": 33.5005, "gps_longitude": -117.15})
        self.assertTrue(r.json()["geofenceOk"])


class AiOffTests(_Base):
    def test_a_submitted_log_is_ready_for_review_with_nothing_queued(self):
        today = construction_company.local_today(self.db, self.db.get(models.ConstructionProject, "pa")).isoformat()
        self._log("l1", status="draft", day=today)
        self._as(CREW)
        self.client.patch("/construction/logs/l1", json={"tags": ["Safety", "weather", "bogus"]})
        r = self.client.post("/construction/logs/l1/submit")
        self.assertEqual((r.status_code, r.json()["status"], r.json()["queuedJobs"]), (200, "submitted", 0))
        self.assertEqual(r.json()["tags"], ["safety", "weather"])
        self.assertEqual(self.db.query(models.ConstructionAIJob).count(), 0)
        self._as(MGR_A)
        q = self.client.get("/construction/review-queue").json()
        self.assertEqual(([l["id"] for l in q], q[0]["awaitingAi"]), (["l1"], False))
        self.assertEqual(self.client.get("/construction/meta").json()["aiEnabled"], False)
        ov = self.client.get("/construction/overview").json()
        # The crew's own tags are what the dashboard counts while AI is off.
        self.assertEqual((ov["tagCounts"]["safety"], ov["tagCounts"]["weather"], ov["safetyFlags"]), (1, 1, 1))
        self.assertFalse(ov["aiEnabled"])

    def test_queued_ai_jobs_are_skipped_never_deleted(self):
        self.db.add(models.ConstructionAIJob(id="j1", kind="log_summarize", subject_id="l1", status="queued"))
        self.db.add(models.ConstructionAIJob(id="j2", kind="egnyte_sync", subject_id="m1", status="queued"))
        self.db.commit()
        self.assertEqual(construction_worker.skip_ai_jobs(self.db), 1)
        rows = {j.id: j.status for j in self.db.query(models.ConstructionAIJob).all()}
        self.assertEqual(rows, {"j1": "skipped", "j2": "queued"})


class WeekRuleTests(_Base):
    def test_the_week_is_the_projects_on_the_jobsites_clock(self):
        p = self.db.get(models.ConstructionProject, "pa")
        # 11/06/2026 03:00 UTC is Thursday 11/05 at 7 PM in Los Angeles.
        now = datetime(2026, 11, 6, 3, 0, tzinfo=timezone.utc)
        self.assertEqual(construction_company.local_today(self.db, p, now), date(2026, 11, 5))
        self.assertEqual(construction_company.current_week_start(self.db, p, now), date(2026, 11, 2))
        p.week_starts_on = 0
        self.assertEqual(construction_company.current_week_start(self.db, p, now), date(2026, 11, 1))

    def test_generate_names_the_week_any_day_falls_in(self):
        self._as(MGR_A)
        r = self.client.post("/construction/projects/pa/reports/generate", json={"week_start": "2026-10-29"})
        self.assertEqual((r.status_code, r.json()["weekStart"]), (201, "2026-10-26"))
        self.assertFalse(r.json()["aiWritten"])

    def test_a_published_week_stays_visible_until_its_new_version_is_published(self):
        self._as(MGR_A)
        first = self.client.post("/construction/projects/pa/reports/generate", json={"week_start": "2026-10-26"}).json()
        self.assertEqual(self.client.post(f"/construction/reports/{first['id']}/publish").status_code, 200)
        second = self.client.post("/construction/projects/pa/reports/generate", json={"week_start": "2026-10-26"}).json()
        self.assertEqual(second["version"], 2)
        self._as(CREW)   # a reader who only ever sees published reports
        seen = [(r["id"], r["status"]) for r in self.client.get("/construction/projects/pa/reports").json()]
        self.assertEqual(seen, [(first["id"], "published")])
        self._as(MGR_A)
        self.client.post(f"/construction/reports/{second['id']}/publish")
        self._as(CREW)
        seen = [(r["id"], r["status"]) for r in self.client.get("/construction/projects/pa/reports").json()]
        self.assertEqual(seen, [(second["id"], "published")])


class BellTests(_Base):
    def test_one_bell_per_reviewer_per_log_and_company_managers_when_none_are_named(self):
        self._log("l1", status="draft")
        self._as(CREW)
        self.client.post("/construction/logs/l1/submit")
        bells = self.db.query(models.NexusNotification).all()
        self.assertEqual(sorted(b.recipient for b in bells), sorted([MGR_A, MGR_A2]))   # job A names no managers
        self._as(MGR_A)
        self.client.post("/construction/logs/l1/review", json={"decision": "needs_info", "note": "Which wall?"})
        self._as(CREW)
        self.client.post("/construction/logs/l1/submit")
        self.db.expire_all()
        rows = self.db.query(models.NexusNotification).all()
        per = {}
        for b in rows:
            per.setdefault(b.recipient, []).append(b)
        self.assertEqual({k: len(v) for k, v in per.items()}, {MGR_A: 1, MGR_A2: 1, CREW: 1})
        self.assertEqual(per[MGR_A][0].title, "Daily Log Ready to Review")
        self.assertFalse(per[MGR_A][0].actioned)
        self.assertEqual(per[CREW][0].title, "Daily Log Sent Back")

    def test_reviewers_never_reach_past_the_company(self):
        p = self.db.get(models.ConstructionProject, "pa")
        self.assertEqual(construction_notify.reviewers(self.db, p), sorted([MGR_A, MGR_A2]))
        z = self.db.get(models.ConstructionProject, "pz")
        z.created_by = MGR_B
        self.assertEqual(construction_notify.reviewers(self.db, z), [MGR_B])

    def test_the_report_email_is_escaped(self):
        sent = []
        p = self.db.get(models.ConstructionProject, "pa")
        p.name = "<script>alert(1)</script> Yard"
        r = models.ConstructionWeeklyReport(id="r1", project_id="pa", week_start="2026-11-02", week_end="2026-11-08",
                                            title="<b>bold</b>", version=1)
        with mock.patch.object(construction_notify, "_send", side_effect=lambda **kw: sent.append(kw) or ""):
            construction_notify.report_published(self.db, p, r, b"")
        html = sent[0]["html"]
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)
        self.assertIn("&lt;b&gt;bold&lt;/b&gt;", html)


class HealthTests(unittest.TestCase):
    T = date(2026, 11, 3)

    def _p(self, **kw):
        base = dict(status="active", percent_complete=50, start_on="2026-06-01", target_finish_on="2026-12-31")
        base.update(kw)
        return models.ConstructionProject(**base)

    def test_late_is_past_the_target_and_not_complete(self):
        h = construction_health.health(self._p(target_finish_on="2026-10-31", percent_complete=94), today=self.T)
        self.assertEqual((h["state"], h["daysPastTarget"]), ("late", 3))
        self.assertEqual(construction_health.health(self._p(target_finish_on="2026-10-31", status="complete"),
                                                    today=self.T)["state"], "complete")

    def test_at_risk_is_a_close_milestone_while_behind_or_an_overdue_rfi(self):
        ms = [models.ConstructionMilestone(id="m", name="Final Inspection", target_date="2026-11-06", status="upcoming")]
        h = construction_health.health(self._p(percent_complete=40), milestones=ms, today=self.T)
        self.assertEqual((h["state"], h["nextMilestone"]["days"]), ("at_risk", 3))
        self.assertEqual(construction_health.health(self._p(percent_complete=90), milestones=ms, today=self.T)["state"],
                         "on_track")
        rfis = [models.ConstructionRfi(id="r", status="open", due_on="2026-10-20")]
        h = construction_health.health(self._p(percent_complete=90), rfis=rfis, today=self.T)
        self.assertEqual((h["state"], h["overdueRfis"]), ("at_risk", 1))

    def test_last_log_and_worst_first(self):
        h = construction_health.health(self._p(), last_log_date="2026-10-31", today=self.T)
        self.assertEqual((h["lastLogDate"], h["daysSinceLog"]), ("2026-10-31", 3))
        rows = [{"name": "B", "health": {"state": "on_track"}}, {"name": "A", "health": {"state": "late"}},
                {"name": "C", "health": {"state": "at_risk"}}]
        self.assertEqual([r["name"] for r in sorted(rows, key=construction_health.sort_key)], ["A", "C", "B"])


if __name__ == "__main__":
    unittest.main()
