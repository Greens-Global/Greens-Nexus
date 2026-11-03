"""Construction phase 2 - jobs and Tasks (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr, feat/construction-jobs).

Pins:
  * a new job gets its task project, stamped from its job type's template
    (Work Order / Construction Project), the template made once per company
    as an ordinary Tasks template and reused; a deleted one is never brought
    back; the job's managers and crew are members;
  * a picked template wins;
  * punch: add (through _create_task, idempotent on a phone-made id), Done
    by the crew, Verified by a reviewer only after Done (the custom status
    "Verified" WITH completed), counts, walls (another company's 404);
  * the milestone move: once, idempotent, old rows kept and marked; health
    reads the task milestones;
  * the Job chip lookup and the schedule read walls.

Run: python -m pytest test_construction_jobs_tasks.py -q
"""
import os
import tempfile

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)

import construction_tasks   # noqa: E402
import models               # noqa: E402
from construction_jobs_testkit import (A, CREW, CREW2, MGR_A, MGR_A2, MGR_B, OUTSIDER, JobsBase, iso)  # noqa: E402


class TaskProjectStamping(JobsBase):
    tmp_db = _tmp.name

    def _new(self, name="Gate Motor", job_type="work_order", **kw):
        self.as_(MGR_A)
        r = self.client.post("/construction/projects", json={"name": name, "job_type": job_type,
                                                             "worker_emails": [CREW], **kw})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def test_a_work_order_is_stamped_from_the_work_order_template(self):
        job = self._new()
        self.assertEqual(job["jobType"], "work_order")
        self.assertTrue(job["taskProjectId"])
        tp = self.fresh(models.TaskProject, job["taskProjectId"])
        self.assertEqual(tp.name, "Gate Motor")
        self.assertIn(CREW, tp.member_emails)
        self.assertEqual(tp.company_id, A)
        names = {s.name for s in self.db.query(models.TaskSection).filter_by(project_id=tp.id)}
        self.assertTrue({"Assess", "Parts", "Repair", "Verify", "Punch", "Closeout"} <= names)
        titles = {t.title for t in self.db.query(models.Task).filter_by(project_id=tp.id)}
        self.assertIn("Make the repair", titles)
        tpl = self.db.query(models.TaskProjectTemplate).filter_by(category="Construction Work Order").one()
        self.assertEqual(tpl.owner_email, MGR_A)
        self.assertEqual(tpl.use_count, 1)

    def test_the_company_template_is_made_once_and_reused(self):
        self._new("One")
        self._new("Two")
        self._new("Build", job_type="project")
        self.assertEqual(self.db.query(models.TaskProjectTemplate).filter_by(
            category="Construction Work Order").count(), 1)
        tpl = self.db.query(models.TaskProjectTemplate).filter_by(category="Construction Work Order").one()
        self.assertEqual(tpl.use_count, 2)
        proj = self.db.query(models.TaskProjectTemplate).filter_by(category="Construction Project").one()
        self.assertEqual(proj.name, "Construction Project")

    def test_a_deleted_template_is_never_brought_back(self):
        self._new("One")
        tpl = self.db.query(models.TaskProjectTemplate).filter_by(category="Construction Work Order").one()
        tpl.deleted_at = iso()
        self.db.commit()
        job = self._new("Two")
        self.assertTrue(job["taskProjectId"])   # the built-in default stood in
        n = (self.db.query(models.TaskProjectTemplate).filter_by(category="Construction Work Order")
             .execution_options(include_deleted=True).count())
        self.assertEqual(n, 1)

    def test_a_picked_template_wins(self):
        self.db.add(models.TaskProjectTemplate(
            id="tpl-mine", name="Roof Swap", category="", payload=construction_tasks._payload(
                ["Tear Off", "Punch"], [{"section": "Tear Off", "title": "Strip the old roof", "start": 0, "due": 2}]),
            access_level="org", owner_email=MGR_A, archived=False, use_count=0, created_at=iso(),
            modified_at=iso(), created_by=MGR_A, deleted_at="", deleted_by=""))
        self.db.commit()
        job = self._new("Roof", job_type="project", task_template_id="tpl-mine")
        titles = {t.title for t in self.db.query(models.Task).filter_by(project_id=job["taskProjectId"])}
        self.assertEqual(titles, {"Strip the old roof"})

    def test_a_create_resent_with_the_same_id_answers_with_the_first_job(self):
        a = self._new("Once", id="job-phone-1")
        b = self._new("Once", id="job-phone-1")
        self.assertEqual(a["id"], b["id"])
        self.assertEqual(self.db.query(models.ConstructionProject).filter_by(id="job-phone-1").count(), 1)


class Punch(JobsBase):
    tmp_db = _tmp.name

    def setUp(self):
        super().setUp()
        self.as_(MGR_A)
        r = self.client.post("/construction/projects/pa/task-project", json={})
        self.assertEqual(r.status_code, 201, r.text)

    def test_crew_adds_marks_done_and_a_manager_verifies(self):
        self.as_(CREW)
        r = self.client.post("/construction/projects/pa/punch", json={"id": "p-1", "title": "Touch up paint",
                                                                      "assignee_emails": [CREW2]})
        self.assertEqual(r.status_code, 201, r.text)
        again = self.client.post("/construction/projects/pa/punch", json={"id": "p-1", "title": "Touch up paint"})
        self.assertEqual(again.json()["id"], "p-1")
        self.assertEqual(self.db.query(models.Task).filter_by(id="p-1").count(), 1)
        # Verified before Done is refused; the crew cannot verify.
        self.as_(MGR_A)
        self.assertEqual(self.client.post("/construction/punch/p-1/verify", json={"verified": True}).status_code, 409)
        self.as_(CREW2)
        self.assertEqual(self.client.post("/construction/punch/p-1/done", json={"done": True}).status_code, 200)
        self.assertEqual(self.client.post("/construction/punch/p-1/verify", json={"verified": True}).status_code, 403)
        self.as_(MGR_A)
        v = self.client.post("/construction/punch/p-1/verify", json={"verified": True})
        self.assertEqual(v.status_code, 200, v.text)
        t = self.fresh(models.Task, "p-1")
        self.assertTrue(t.completed)
        status = self.db.get(models.TaskCustomStatus, t.status)
        self.assertEqual(status.label, "Verified")
        view = self.client.get("/construction/projects/pa/schedule").json()
        self.assertEqual(view["punch"], {"open": 0, "done": 0, "verified": 1, "total": 1})
        # Unverify puts it back to plain Done.
        self.client.post("/construction/punch/p-1/verify", json={"verified": False})
        t = self.fresh(models.Task, "p-1")
        self.assertEqual((t.status, bool(t.completed)), ("completed", True))

    def test_another_company_never_reaches_the_punch_list(self):
        self.as_(CREW)
        self.client.post("/construction/projects/pa/punch", json={"id": "p-2", "title": "Caulk window"})
        self.as_(MGR_B)
        self.assertEqual(self.client.get("/construction/projects/pa/schedule").status_code, 404)
        self.assertEqual(self.client.post("/construction/punch/p-2/done", json={"done": True}).status_code, 404)
        self.assertEqual(self.client.post("/construction/projects/pa/punch", json={"title": "x"}).status_code, 404)
        self.as_(OUTSIDER)
        self.assertEqual(self.client.post("/construction/projects/pa/punch", json={"title": "x"}).status_code, 403)

    def test_the_job_chip_lookup_is_walled(self):
        tp = self.fresh(models.ConstructionProject, "pa").task_project_id
        self.as_(CREW)
        self.assertEqual(self.client.get(f"/construction/task-projects/{tp}/job").json()["job"]["id"], "pa")
        self.as_(MGR_B)
        self.assertIsNone(self.client.get(f"/construction/task-projects/{tp}/job").json()["job"])


class MilestoneMove(JobsBase):
    tmp_db = _tmp.name

    def test_milestones_move_once_and_the_old_rows_stay(self):
        for i, (name, day, st) in enumerate((("Foundation Poured", "2026-12-01", "hit"),
                                             ("Dried In", "2027-01-15", "upcoming"))):
            self.db.add(models.ConstructionMilestone(id=f"m{i}", project_id="pa", name=name, target_date=day,
                                                     status=st, critical=bool(i), created_at=iso(),
                                                     modified_at=iso(), deleted_at="", migrated_task_id=""))
        self.db.commit()
        self.assertEqual(construction_tasks.migrate_all(self.db), 2)
        self.assertEqual(construction_tasks.migrate_all(self.db), 0)   # idempotent
        self.db.expire_all()
        rows = self.db.query(models.ConstructionMilestone).filter_by(project_id="pa").all()
        self.assertEqual(len(rows), 2)
        for m in rows:
            t = self.db.get(models.Task, m.migrated_task_id)
            self.assertTrue(t.is_milestone)
            self.assertEqual(t.due_on, m.target_date)
            self.assertEqual(bool(t.completed), m.status == "hit")
        # Health reads the task milestones now.
        self.as_(MGR_A)
        h = self.client.get("/construction/projects/pa").json()["health"]
        self.assertEqual(h["nextMilestone"]["name"], "Dried In")
        # A job under way keeps ITS schedule: the template's sections (Punch
        # among them), never its tasks dated from today.
        tp = self.fresh(models.ConstructionProject, "pa").task_project_id
        names = {t.title for t in self.db.query(models.Task).filter_by(project_id=tp)}
        self.assertEqual(names, {"Foundation Poured", "Dried In"})
        self.assertIn("Punch", {s.name for s in self.db.query(models.TaskSection).filter_by(project_id=tp)})

    def test_an_edit_adding_crew_adds_them_to_the_task_project(self):
        self.as_(MGR_A)
        self.client.post("/construction/projects/pa/task-project", json={})
        r = self.client.patch("/construction/projects/pa", json={"worker_emails": [CREW, CREW2, MGR_A2]})
        self.assertEqual(r.status_code, 200, r.text)
        tp = self.fresh(models.TaskProject, self.fresh(models.ConstructionProject, "pa").task_project_id)
        self.assertIn(MGR_A2, tp.member_emails)


if __name__ == "__main__":
    import unittest
    unittest.main()
