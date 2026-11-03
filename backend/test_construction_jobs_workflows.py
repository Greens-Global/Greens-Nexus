"""Construction phase 2 - the Workflows pack and the Approvals sources
(Neil, 11/03/2026, plan https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr).

Pins:
  * the pack registers job / daily_log / rfi / submittal and the eight
    events, and loads without errors (the catalog lock test covers the
    snapshot);
  * each choke point writes exactly one outbox row for its event, with the
    job's company: job.created, job.status_changed, job.phase_changed,
    daily_log.submitted, daily_log.reviewed, rfi.opened, rfi.answered,
    submittal.decided;
  * Approvals: an open RFI owed by me and a submittal awaiting my decision
    are rows in my inbox (and counted on Construction's nav), never another
    company's, never once answered / decided; naming the responder bells
    them once.

Run: python -m pytest test_construction_jobs_workflows.py -q
"""
import os
import tempfile

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)

import approvals_inbox       # noqa: E402
import models                # noqa: E402
import workflows.catalog as catalog  # noqa: E402
from construction_jobs_testkit import (A, B, CREW, MGR_A, MGR_A2, MGR_B, OUTSIDER, JobsBase, iso)  # noqa: E402


def _events(db, key):
    return db.query(models.WorkflowEvent).filter(models.WorkflowEvent.key == key).all()


class Pack(JobsBase):
    tmp_db = _tmp.name

    def test_the_pack_registers_its_entities_and_events(self):
        catalog.load_packs()
        self.assertNotIn("construction", catalog.load_errors)
        for e in ("job", "daily_log", "rfi", "submittal"):
            self.assertIn(e, catalog.ENTITIES)
        for k in ("job.created", "job.status_changed", "job.phase_changed", "daily_log.submitted",
                  "daily_log.reviewed", "rfi.opened", "rfi.answered", "submittal.decided"):
            self.assertIn(k, catalog.EVENTS)

    def test_every_choke_point_emits_once(self):
        self.as_(MGR_A)
        job = self.client.post("/construction/projects", json={"name": "Emit Job", "job_type": "work_order"}).json()
        self.assertEqual([(e.subject_id, e.company_id) for e in _events(self.db, "job.created")], [(job["id"], A)])
        self.client.patch(f"/construction/projects/{job['id']}", json={"phase": "Framing"})
        self.client.patch(f"/construction/projects/{job['id']}", json={"status": "on_hold"})
        self.assertEqual(len(_events(self.db, "job.phase_changed")), 1)
        self.assertEqual(len(_events(self.db, "job.status_changed")), 1)
        # A daily log: submitted by the crew, reviewed by a manager.
        self.as_(CREW)
        lg = self.client.post("/construction/projects/pa/logs", json={"notes_raw": "Framed the east wall"}).json()
        self.client.patch(f"/construction/logs/{lg['id']}", json={"notes_raw": "Framed the east wall"})
        self.assertEqual(self.client.post(f"/construction/logs/{lg['id']}/submit").status_code, 200)
        self.as_(MGR_A)
        self.assertEqual(self.client.post(f"/construction/logs/{lg['id']}/review",
                                          json={"decision": "approve"}).status_code, 200)
        self.assertEqual(len(_events(self.db, "daily_log.submitted")), 1)
        rev = _events(self.db, "daily_log.reviewed")
        self.assertEqual(len(rev), 1)
        self.assertEqual(rev[0].company_id, A)
        # RFI opened, then answered; a submittal decided.
        rfi = self.client.post("/construction/projects/pa/register/rfis",
                               json={"subject": "Beam depth", "responder_email": MGR_A2}).json()
        self.client.patch(f"/construction/register/rfis/{rfi['id']}", json={"status": "answered", "answer": "12 in"})
        self.client.patch(f"/construction/register/rfis/{rfi['id']}", json={"answer": "12 in, see detail 4"})
        sub = self.client.post("/construction/projects/pa/register/submittals", json={"title": "Roof membrane"}).json()
        self.client.patch(f"/construction/register/submittals/{sub['id']}", json={"status": "approved_as_noted"})
        self.assertEqual(len(_events(self.db, "rfi.opened")), 1)
        self.assertEqual(len(_events(self.db, "rfi.answered")), 1)
        self.assertEqual(len(_events(self.db, "submittal.decided")), 1)


class ApprovalsSources(JobsBase):
    tmp_db = _tmp.name

    def setUp(self):
        super().setUp()
        self.db.add(models.ConstructionRfi(id="r1", project_id="pa", number="RFI-1", subject="Beam", status="open",
                                           responder_email=MGR_A2, due_on="2026-11-10", created_at=iso(),
                                           modified_at=iso(), deleted_at=""))
        self.db.add(models.ConstructionRfi(id="r2", project_id="pa", subject="Old", status="answered",
                                           responder_email=MGR_A2, created_at=iso(), modified_at=iso(), deleted_at=""))
        self.db.add(models.ConstructionRfi(id="r3", project_id="pb", subject="Theirs", status="open",
                                           responder_email=MGR_A2, created_at=iso(), modified_at=iso(), deleted_at=""))
        self.db.add(models.ConstructionSubmittal(id="s1", project_id="pa", number="SUB-1", title="Membrane",
                                                 status="submitted", approver_email=MGR_A2, created_at=iso(),
                                                 modified_at=iso(), deleted_at=""))
        self.db.add(models.ConstructionSubmittal(id="s2", project_id="pa", title="Done", status="approved",
                                                 approver_email=MGR_A2, created_at=iso(), modified_at=iso(),
                                                 deleted_at=""))
        self.db.commit()

    def test_my_rfis_and_submittals_wait_in_my_inbox(self):
        self.as_(MGR_A2)
        import auth
        user = {"email": MGR_A2, "role": "manager", "level": auth._LEVELS["manager"]}
        out = approvals_inbox.collect(self.db, user)
        keys = sorted(r["key"] for r in out["rows"] if r["kind"].startswith("construction_"))
        self.assertEqual(keys, ["construction_rfi_response:r1", "construction_submittal_decision:s1"])
        row = next(r for r in out["rows"] if r["key"] == "construction_rfi_response:r1")
        self.assertEqual(row["link"], {"view": "ops", "sub": "project:pa:rfis"})
        self.assertEqual(row["due"], "2026-11-10")
        counts = self.client.get("/me/action-counts").json()
        flat = repr(counts)
        self.assertIn("construction-dashboard", flat)

    def test_another_companys_manager_gets_nothing(self):
        import auth
        user = {"email": MGR_B, "role": "manager", "level": auth._LEVELS["manager"]}
        out = approvals_inbox.collect(self.db, user)
        self.assertEqual([r for r in out["rows"] if r["kind"].startswith("construction_r")], [])

    def test_naming_a_responder_bells_them_once(self):
        self.as_(MGR_A)
        rfi = self.client.post("/construction/projects/pa/register/rfis",
                               json={"subject": "Slab edge", "responder_email": MGR_A2}).json()
        self.client.patch(f"/construction/register/rfis/{rfi['id']}", json={"question": "Which detail?"})
        bells = self.db.query(models.NexusNotification).filter_by(recipient=MGR_A2, ref_id=rfi["id"]).all()
        self.assertEqual(len(bells), 1)
        self.assertEqual(bells[0].title, "RFI to Answer - Job A")
        # Someone who cannot open the job is refused, with a sentence.
        r = self.client.post("/construction/projects/pa/register/rfis", json={"subject": "y", "responder_email": OUTSIDER})
        self.assertEqual(r.status_code, 422)
        self.assertIn("cannot open this job", r.json()["detail"])
        # A responder outside the caller's companies is refused.
        r = self.client.post("/construction/projects/pa/register/rfis", json={"subject": "x", "responder_email": MGR_B})
        self.assertEqual(r.status_code, 422)
        self.assertNotIn(B, [b.company for b in bells])

    def test_the_named_responder_answers_and_nothing_else(self):
        # CREW is on the job (may read it) but is no reviewer.
        r = self.db.get(models.ConstructionRfi, "r1")
        r.responder_email = CREW
        self.db.commit()
        self.as_(CREW)
        ok = self.client.patch("/construction/register/rfis/r1", json={"answer": "12 in", "status": "answered"})
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(self.client.patch("/construction/register/rfis/r1", json={"subject": "Mine"}).status_code, 403)
        self.assertEqual(self.client.patch("/construction/register/rfis/r1", json={"status": "void"}).status_code, 403)
        self.assertEqual(self.client.patch("/construction/register/submittals/s1",
                                           json={"status": "approved"}).status_code, 403)   # not named on it


if __name__ == "__main__":
    import unittest
    unittest.main()
