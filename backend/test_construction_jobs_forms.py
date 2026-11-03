"""Construction phase 2 - Forms on a job (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr).

Pins:
  * an entry filed with a picked job is linked to it - only when the
    submitter is on the job (never another company's, never a job they are
    not on: the entry still files, unlinked);
  * filled from a jobsite shift (project-<id>) the entry takes that job -
    only the submitter's own shift;
  * a reviewer links an entry to a job through /entries/{id}/link;
  * the Job's Field tab lists its entries (title, who, when, status - never
    the answers), walled; Fill a Form's job picker lists the caller's jobs,
    today's shifts first.

Run: python -m pytest test_construction_jobs_forms.py -q
"""
import os
import tempfile
import uuid

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)

import construction_company  # noqa: E402
import models               # noqa: E402
from construction_jobs_testkit import (ADMIN, CREW, CREW2, MGR_A, MGR_B, OUTSIDER, JobsBase, iso)  # noqa: E402

FIELDS = [{"token": "checked", "label": "What Was Checked", "type": "text", "required": True, "section": "Safety"}]


class FormsOnAJob(JobsBase):
    tmp_db = _tmp.name

    def setUp(self):
        super().setUp()
        self.as_(ADMIN)
        r = self.client.post("/documents/templates", json={"name": "Toolbox Talk", "docType": "form",
                                                           "category": "safety", "status": "active",
                                                           "fieldDefs": FIELDS, "audience": "company"})
        self.assertEqual(r.status_code, 200, r.text)
        self.tid = r.json()["id"]

    def _submit(self, who, **extra):
        self.as_(who)
        r = self.client.post(f"/forms/{self.tid}/entries", json={
            "entryKey": str(uuid.uuid4()), "answers": {"checked": "Ladders tied off"}, "source": "phone", **extra})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_a_picked_job_links_the_entry_only_for_someone_on_it(self):
        e = self._submit(CREW, projectId="pa")
        self.assertEqual(e["linkedProjectId"], "pa")
        e2 = self._submit(OUTSIDER, projectId="pa")   # not on the job: files, unlinked
        self.assertEqual(e2["linkedProjectId"], "")
        e3 = self._submit(CREW, projectId="pb")       # another company's job
        self.assertEqual(e3["linkedProjectId"], "")

    def test_an_entry_from_a_jobsite_shift_takes_that_job(self):
        self.db.add(models.ScheduledShift(id="sh-1", employee_email=CREW2, work_date="2026-11-03",
                                          start_hhmm="07:00", end_hhmm="15:00", published=1, pending_delete=0,
                                          jobsite="project-pa", created_at=iso()))
        self.db.commit()
        self.assertEqual(self._submit(CREW2, shiftId="sh-1")["linkedProjectId"], "pa")
        self.assertEqual(self._submit(CREW, shiftId="sh-1")["linkedProjectId"], "")   # not their shift

    def test_a_reviewer_links_an_entry_and_the_job_lists_it_without_answers(self):
        e = self._submit(CREW)
        self.as_(ADMIN)
        r = self.client.post(f"/forms/entries/{e['id']}/link", json={"projectId": "pa"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["linkedProjectId"], "pa")
        self.assertEqual(self.client.post(f"/forms/entries/{e['id']}/link", json={"projectId": "nope"}).status_code, 404)
        # The Forms reach rule decides who sees the entry on the job too: the
        # administrator does; a job manager the rule does not admit sees none.
        rows = self.client.get("/construction/projects/pa/forms").json()["entries"]
        self.assertEqual([x["id"] for x in rows], [e["id"]])
        self.assertNotIn("answers", rows[0])
        self.as_(MGR_A)
        self.assertEqual(self.client.get("/construction/projects/pa/forms").json()["entries"], [])
        self.as_(CREW)    # the submitter always sees their own
        self.assertEqual([x["id"] for x in self.client.get("/construction/projects/pa/forms").json()["entries"]], [e["id"]])
        self.as_(MGR_B)
        self.assertEqual(self.client.get("/construction/projects/pa/forms").status_code, 404)

    def test_the_job_picker_lists_my_jobs_todays_shift_first(self):
        self.db.add(self.job("pc", "Another Job A", "co-a", managers=[MGR_A], workers=[CREW]))
        today = construction_company.local_today(self.db, self.fresh(models.ConstructionProject, "pc")).isoformat()
        self.db.add(models.ScheduledShift(id="sh-2", employee_email=CREW, work_date=today, start_hhmm="07:00",
                                          end_hhmm="15:00", published=1, pending_delete=0, jobsite="project-pc",
                                          created_at=iso()))
        self.db.commit()
        self.as_(CREW)
        jobs = self.client.get("/construction/my-jobs").json()["jobs"]
        self.assertEqual([(j["id"], j["onShiftToday"]) for j in jobs], [("pc", True), ("pa", False)])


if __name__ == "__main__":
    import unittest
    unittest.main()
