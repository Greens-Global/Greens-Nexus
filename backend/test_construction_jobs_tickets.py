"""Construction phase 2 - Tickets are the work orders (Neil, 11/03/2026,
plan https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr).

Pins:
  * Start Job makes a Work Order job prefilled from the ticket (subject,
    description, requester, property - a private one dropped), links ticket
    <-> job with a line in both histories; a second Start Job answers with
    the same job; another existing job may be named instead;
  * never a confidential (Ask HR) ticket, never across the company wall,
    managers only;
  * the two-way sync, by ANY path (the before_flush hook): job complete ->
    open tickets resolved with a note (a closed one left alone); ticket
    reopened -> a Complete job back to Active; a resolved ticket never
    completes its job; the property link is never re-pointed;
  * the job shows its source tickets (photos included) and a ticket its jobs.

Run: python -m pytest test_construction_jobs_tickets.py -q
"""
import os
import tempfile

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)

import construction_ticket_sync  # noqa: E402
import models               # noqa: E402
from construction_jobs_testkit import (A, ADMIN, B, CREW, MGR_A, MGR_B, JobsBase, iso)  # noqa: E402

# The resolved email / Teams sends go off the request in a thread; here they
# are recorded instead (H1 pins that the desk's own sends are queued).
SENT = []
construction_ticket_sync.SEND = lambda fn, *a, **kw: SENT.append((getattr(fn, "__name__", ""), a, kw))


class StartJob(JobsBase):
    tmp_db = _tmp.name

    def setUp(self):
        super().setUp()
        self.db.add(models.PropertyAsset(id="prop-1", payload={"name": "Escondido Yard", "asset_kind": "property",
                                                               "entity": "Greens Build"}))
        self.db.add(models.PropertyAsset(id="prop-private", payload={"name": "Owner House", "private": True,
                                                                     "asset_kind": "property"}))
        self._ticket("t1", property_id="prop-1")
        self._ticket("t-hr", confidential="hr")
        self._ticket("t-b", company=B, requester=MGR_B)
        self._ticket("t-priv", property_id="prop-private")
        self.db.add(models.TaskAttachment(id="att-1", task_id="t1", name="gate.jpg", size=10, kind="image",
                                          url="https://proj.supabase.co/storage/v1/object/public/task-files/t1/gate.jpg",
                                          added_at=iso(), added_by=CREW))
        self.db.commit()

    def _ticket(self, tid, company=A, requester=MGR_A, property_id="", confidential="", status="open"):
        self.db.add(models.TaskTicket(id=tid, code=tid.upper(), subject=f"Gate motor stuck ({tid})",
                                      description="The east gate will not open.", status=status,
                                      requester_email=requester, company_id=company,
                                      property_asset_id=property_id, property_name="Escondido Yard" if property_id else "",
                                      confidential_desk=confidential, created_at=iso(), modified_at=iso(),
                                      deleted_at=""))

    def test_start_job_makes_a_prefilled_work_order_and_links_both_ways(self):
        self.as_(MGR_A)
        r = self.client.post("/construction/tickets/t1/start-job", json={"worker_emails": [CREW]})
        self.assertEqual(r.status_code, 201, r.text)
        job = r.json()["job"]
        self.assertTrue(r.json()["created"])
        self.assertEqual(job["jobType"], "work_order")
        self.assertEqual(job["propertyId"], "prop-1")
        self.assertIn("Gate motor stuck", job["name"])
        self.assertIn(MGR_A, job["description"])
        self.assertTrue(job["taskProjectId"])
        links = self.db.query(models.ConstructionJobLink).filter_by(kind="ticket", ref_id="t1").all()
        self.assertEqual([lk.project_id for lk in links], [job["id"]])
        hist = [a.detail for a in self.db.query(models.TaskActivity).filter_by(entity_kind="ticket", entity_id="t1")]
        self.assertTrue(any("started the job" in d for d in hist), hist)
        # A second Start Job answers with the same job.
        again = self.client.post("/construction/tickets/t1/start-job", json={}).json()
        self.assertEqual((again["job"]["id"], again["created"]), (job["id"], False))
        # The job shows its ticket (and its photo); the ticket its job.
        conn = self.client.get(f"/construction/projects/{job['id']}/connected").json()
        self.assertEqual([t["id"] for t in conn["tickets"]], ["t1"])
        self.assertEqual(len(conn["tickets"][0]["photos"]), 1)
        self.assertEqual([j["id"] for j in self.client.get("/construction/tickets/t1/jobs").json()["jobs"]], [job["id"]])

    def test_a_private_property_the_caller_cannot_see_is_dropped(self):
        self.as_(MGR_A)
        job = self.client.post("/construction/tickets/t-priv/start-job", json={}).json()["job"]
        self.assertIsNone(job["propertyId"])

    def test_an_existing_job_can_take_the_ticket(self):
        self.as_(MGR_A)
        r = self.client.post("/construction/tickets/t1/start-job", json={"project_id": "pa"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["job"]["id"], "pa")
        self.assertFalse(r.json()["created"])

    def test_start_job_puts_the_job_in_the_tickets_company(self):
        # A Super Administrator (company A) starts a job on company B's ticket.
        self.as_(ADMIN)
        job = self.client.post("/construction/tickets/t-b/start-job", json={}).json()["job"]
        self.assertEqual(job["companyId"], B)

    def test_never_confidential_never_across_the_wall_managers_only(self):
        self.as_(MGR_A)
        self.assertEqual(self.client.post("/construction/tickets/t-hr/start-job", json={}).status_code, 404)
        self.assertEqual(self.client.post("/construction/tickets/t-b/start-job", json={}).status_code, 404)
        self.assertEqual(self.client.post("/construction/tickets/t1/start-job", json={"project_id": "pb"}).status_code, 404)
        self.as_(CREW)
        self.assertIn(self.client.post("/construction/tickets/t1/start-job", json={}).status_code, (403,))


class TwoWaySync(JobsBase):
    tmp_db = _tmp.name

    def setUp(self):
        super().setUp()
        SENT.clear()
        for tid, st, desk in (("t1", "in_progress", ""), ("t2", "closed", ""), ("t-hr", "open", "hr")):
            self.db.add(models.TaskTicket(id=tid, code=tid.upper(), subject="Fix", status=st, requester_email=CREW,
                                          company_id=A, property_asset_id="prop-1", created_at=iso(),
                                          modified_at=iso(), deleted_at="", resolution_note="", resolution="",
                                          confidential_desk=desk))
            self.db.add(models.ConstructionJobLink(id=f"lk-{tid}", project_id="pa", kind="ticket", ref_id=tid,
                                                   created_by=MGR_A, created_at=iso(), ended_at=""))
        self.db.commit()

    def test_job_complete_resolves_its_open_tickets_with_a_note(self):
        # Completed by someone who works the desk (an administrator) - the
        # resolve runs as them, through the desk's own path.
        self.as_(ADMIN)
        r = self.client.patch("/construction/projects/pa", json={"status": "complete"})
        self.assertEqual(r.status_code, 200, r.text)
        t1, t2 = self.fresh(models.TaskTicket, "t1"), self.fresh(models.TaskTicket, "t2")
        self.assertEqual(t1.status, "resolved")
        self.assertEqual(t1.resolution, "done")
        self.assertIn("Job A", t1.resolution_note)
        self.assertTrue(t1.resolved_at)
        self.assertEqual(t1.property_asset_id, "prop-1")     # never re-pointed (property_links rule 5)
        self.assertEqual(t2.status, "closed")                # already closed: left alone
        hist = [a.detail for a in self.db.query(models.TaskActivity).filter_by(entity_kind="ticket", entity_id="t1")]
        self.assertTrue(any("Resolved" in d for d in hist))
        # The desk's own Mark Resolved path ran: the requester's bell, the
        # unread dot, and the resolved email / Teams queued (after the commit).
        nexus = [n.title for n in self.db.query(models.NexusNotification).filter_by(recipient=CREW).all()]
        self.assertIn("Your Ticket Was Resolved", nexus)
        self.assertTrue(t1.requester_update_at)
        self.assertIn(("notify_ticket_event", ("t1", "resolved", ADMIN)), [(n, a[:3]) for n, a, _ in SENT])

    def test_a_job_manager_without_the_desk_leaves_the_ticket_to_the_desk(self):
        self.as_(MGR_A)      # manages the job, does not work the ticket desk, is not the requester
        self.assertEqual(self.client.patch("/construction/projects/pa", json={"status": "complete"}).status_code, 200)
        self.assertEqual(self.fresh(models.TaskTicket, "t1").status, "in_progress")
        # Never an Ask HR ticket.
        hr = self.db.query(models.TaskTicket).execution_options(include_confidential=True).filter_by(id="t-hr").one()
        self.assertEqual(hr.status, "open")

    def test_a_ticket_the_completer_may_not_act_on_stays_open(self):
        # Company B's manager runs job B; the linked ticket is company A's.
        self.db.add(models.ConstructionJobLink(id="lk-b", project_id="pb", kind="ticket", ref_id="t1",
                                               created_by=MGR_B, created_at=iso(), ended_at=""))
        self.db.commit()
        self.as_(MGR_B)
        self.assertEqual(self.client.patch("/construction/projects/pb", json={"status": "complete"}).status_code, 200)
        self.assertEqual(self.fresh(models.TaskTicket, "t1").status, "in_progress")

    def test_a_reopened_ticket_puts_a_complete_job_back_to_active_by_any_path(self):
        job = self.fresh(models.ConstructionProject, "pa")
        job.status = "complete"
        self.db.commit()
        t2 = self.fresh(models.TaskTicket, "t2")
        t2.status = "reopened"          # any path: a plain ORM write
        self.db.commit()
        self.assertEqual(self.fresh(models.ConstructionProject, "pa").status, "active")
        acts = [a for a in self.db.query(models.ConstructionActivity).filter_by(project_id="pa", type="reopened")]
        self.assertEqual(len(acts), 1)
        self.assertIn("T2", acts[0].detail)            # by number,
        self.assertNotIn("Fix", acts[0].detail)        # never the subject

    def test_a_resolved_ticket_never_completes_its_job(self):
        t1 = self.fresh(models.TaskTicket, "t1")
        t1.status = "resolved"
        self.db.commit()
        self.assertEqual(self.fresh(models.ConstructionProject, "pa").status, "active")

    def test_an_on_hold_job_is_left_alone_when_a_ticket_reopens(self):
        job = self.fresh(models.ConstructionProject, "pa")
        job.status = "on_hold"
        self.db.commit()
        t2 = self.fresh(models.TaskTicket, "t2")
        t2.status = "open"
        self.db.commit()
        self.assertEqual(self.fresh(models.ConstructionProject, "pa").status, "on_hold")


if __name__ == "__main__":
    import unittest
    unittest.main()
