"""Hiring pipeline (Neil/Pranshu call, Oct 8) - intake, stage actions,
scheduling and the interview follow-up.

Intake: the role comes from the company's job roles and decides the title and
department; "Other" keeps a typed title + department; a role of another
company is refused; email is checked; a candidate can be edited.

Stages: each stage has its own moves; Interview is reached only by
scheduling one (with who it is with - the Teams invite goes to the candidate
and the interviewers); the questionnaire is the role's, else General; another
round from Offer goes back to Interview; reschedule/cancel withdraw invites.

Run with: python -m unittest test_hiring_pipeline -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
from routers import hr  # noqa: E402
from routers import hr_interviews as hi  # noqa: E402

ENT, OTHER_ENT = "ent-pipe", "ent-other"
HR_USER = {"email": "hana.hr@greensglobal.com", "level": 5, "role": "admin"}
NEIL = "neil@greensglobal.com"


class PipelineCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.HrCandidate, models.HrStageEvent, models.NexusGroup, models.HrEntity,
                  models.HrDepartment, models.NexusEmployee, models.HrInterview, models.HrInterviewTemplate,
                  models.NexusNotification):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=ENT, name="Pipe Co"))
        self.db.add(models.HrEntity(id=OTHER_ENT, name="Other Co"))
        self.db.add(models.NexusGroup(id="role-analyst", name="Senior Analyst", department="Accounting",
                                      is_job_role=1, company_id=ENT))
        self.db.add(models.NexusGroup(id="role-shared", name="IT Support Associate", department="IT",
                                      is_job_role=1, company_id=""))
        self.db.add(models.NexusGroup(id="role-elsewhere", name="Chef", department="Kitchen",
                                      is_job_role=1, company_id=OTHER_ENT))
        self.db.add(models.NexusEmployee(id="e-neil", work_email=NEIL, first_name="Neil", last_name="K",
                                         company=ENT, status="active"))
        self.db.commit()
        # Graph is a side effect: record the invites instead of sending them.
        self.invites = []
        self._real_meet, self._real_cancel = hi._graph_create_meeting, hi._graph_cancel_meeting

        def meet(*a, **k):
            self.invites.append((a, k))
            return {"eventId": f"ev{len(self.invites)}", "joinUrl": "https://teams/x"}

        def cancel(org, ev):
            self.invites.append(("cancel", ev))
            return ""
        hi._graph_create_meeting, hi._graph_cancel_meeting = meet, cancel

    def tearDown(self):
        hi._graph_create_meeting, hi._graph_cancel_meeting = self._real_meet, self._real_cancel
        self.db.close()

    def _add(self, **kw):
        body = {"first_name": "Jane", "last_name": "Doe", "email": "jane@gmail.com", "company": ENT}
        body.update(kw)
        return hr.create_candidate(hr.CandidateIn(**body), user=HR_USER, db=self.db)

    def _cand(self, stage="applied", **kw):
        c = self._add(**kw)
        self.db.query(models.HrCandidate).filter_by(id=c["id"]).update({"stage": stage})
        self.db.commit()
        return c["id"]

    def _schedule(self, cid, **kw):
        body = {"at": "2026-11-02T17:00:00Z"}
        body.update(kw)
        return hi.schedule_interview(cid, hi.ScheduleIn(**body), user=HR_USER, db=self.db)

    def _stage(self, cid):
        self.db.expire_all()
        return self.db.query(models.HrCandidate).filter_by(id=cid).first()


class IntakeTests(PipelineCase):
    def test_options_offer_the_company_roles_and_shared_ones_with_departments(self):
        out = hr.hiring_options(company_id=ENT, user=HR_USER, db=self.db)
        names = {r["name"]: r["department"] for r in out["roles"]}
        self.assertEqual(names, {"Senior Analyst": "Accounting", "IT Support Associate": "IT"})
        self.assertIn("Accounting", out["departments"])
        self.assertIn("LinkedIn", out["sources"])

    def test_all_roles_for_questionnaire_links(self):
        out = hr.hiring_options(all_roles=True, user=HR_USER, db=self.db)
        self.assertEqual(len(out["roles"]), 3)
        self.assertIn("Other Co", [r["companyName"] for r in out["roles"]])

    def test_role_decides_title_and_department(self):
        c = self._add(role_id="role-analyst", role_title="typed by hand", department="Wrong")
        self.assertEqual((c["roleId"], c["roleTitle"], c["department"]), ("role-analyst", "Senior Analyst", "Accounting"))

    def test_other_keeps_the_typed_title_and_department(self):
        c = self._add(role_title="Leasing Coordinator", department="Operations")
        self.assertEqual((c["roleId"], c["roleTitle"], c["department"]), ("", "Leasing Coordinator", "Operations"))

    def test_role_of_another_company_is_refused(self):
        with self.assertRaises(HTTPException) as e:
            self._add(role_id="role-elsewhere")
        self.assertIn("different company", e.exception.detail)

    def test_bad_email_is_refused(self):
        with self.assertRaises(HTTPException):
            self._add(email="not-an-email")

    def test_edit_fixes_the_email_and_changes_the_role(self):
        c = self._add(email="")
        out = hr.update_candidate(c["id"], hr.CandidateUpdate(email="Jane.Doe@Gmail.com", role_id="role-shared"),
                                  user=HR_USER, db=self.db)
        self.assertEqual((out["email"], out["roleTitle"], out["department"]), ("jane.doe@gmail.com", "IT Support Associate", "IT"))


class StageTests(PipelineCase):
    def _move(self, cid, stage):
        return hr.update_candidate(cid, hr.CandidateUpdate(stage=stage), user=HR_USER, db=self.db)

    def test_each_stage_has_its_own_moves(self):
        cid = self._cand("applied")
        self.assertEqual(self._move(cid, "screening")["stage"], "screening")
        with self.assertRaises(HTTPException) as e:      # Screening -> schedule, never "move"
            self._move(cid, "interview")
        self.assertIn("Schedule the interview", e.exception.detail)
        with self.assertRaises(HTTPException):          # no skipping to Hired
            self._move(cid, "hired")
        self.assertEqual(self._move(cid, "rejected")["stage"], "rejected")
        self.assertEqual(self._move(cid, "applied")["stage"], "applied")     # reopen

    def test_scheduling_invites_candidate_and_interviewers_and_moves_to_interview(self):
        cid = self._cand("screening", role_id="role-analyst")
        out = self._schedule(cid, duration_min=60, interviewer_emails=[NEIL])
        self.assertTrue(out["inviteSent"])
        (args, kw), = self.invites
        self.assertEqual(args[3], "jane@gmail.com")
        self.assertEqual([a["email"] for a in kw["extra_attendees"]], [NEIL])
        self.assertEqual(out["interviewerEmails"], [NEIL])
        c = self._stage(cid)
        self.assertEqual((c.stage, c.interview_at), ("interview", "2026-11-02T17:00:00Z"))
        self.assertTrue(self.db.query(models.NexusNotification).filter_by(recipient=NEIL).count())
        notes = [h.note for h in self.db.query(models.HrStageEvent).filter_by(candidate_id=cid).all()]
        self.assertTrue(any("with Neil K" in n for n in notes))
        rounds = hi.candidate_interviews(cid, user=HR_USER, db=self.db)
        self.assertEqual(rounds[0]["interviewerNames"], ["Neil K"])

    def test_interviewers_must_be_nexus_people(self):
        cid = self._cand("screening")
        with self.assertRaises(HTTPException):
            self._schedule(cid, interviewer_emails=["x@y.com"])

    def test_questionnaire_is_the_roles_then_general(self):
        self.db.add(models.HrInterviewTemplate(id="q-gen", name="General", questions=[{"id": "1", "q": "Why us?"}],
                                               is_general=True))
        self.db.add(models.HrInterviewTemplate(id="q-an", name="Analyst", questions=[{"id": "2", "q": "Build a model"}],
                                               role_ids=["role-analyst"]))
        self.db.commit()
        a = self._cand("screening", role_id="role-analyst")
        b = self._cand("screening", role_id="role-shared")
        ia, ib = self._schedule(a), self._schedule(b, at="2026-11-02T18:00:00Z")
        self.assertEqual((ia["templateName"], ib["templateName"]), ("Analyst", "General"))
        self.assertEqual(ia["answers"][0]["q"], "Build a model")
        none = self._schedule(self._cand("screening"), template_id="none")
        self.assertEqual(none["answers"], [])

    def test_linking_a_role_moves_it_off_the_old_questionnaire_and_one_general(self):
        q1 = hi.create_template(hi.TemplateIn(name="A", questions=["q"], role_ids=["role-analyst"], is_general=True),
                                user=HR_USER, db=self.db)
        q2 = hi.create_template(hi.TemplateIn(name="B", questions=["q"], role_ids=["role-analyst"], is_general=True),
                                user=HR_USER, db=self.db)
        self.db.expire_all()
        t1 = self.db.query(models.HrInterviewTemplate).filter_by(id=q1["id"]).first()
        t2 = self.db.query(models.HrInterviewTemplate).filter_by(id=q2["id"]).first()
        self.assertEqual((t1.role_ids, bool(t1.is_general)), ([], False))
        self.assertEqual((t2.role_ids, bool(t2.is_general)), (["role-analyst"], True))

    def test_another_round_from_offer_goes_back_to_interview(self):
        cid = self._cand("offer")
        self._schedule(cid)
        self.assertEqual(self._stage(cid).stage, "interview")

    def test_reschedule_withdraws_the_old_invite_and_cancel_clears_the_date(self):
        cid = self._cand("screening")
        first = self._schedule(cid)
        second = self._schedule(cid, at="2026-11-03T17:00:00Z", replace_interview_id=first["id"])
        self.assertIn(("cancel", "ev1"), self.invites)
        self.db.expire_all()
        self.assertEqual(self.db.query(models.HrInterview).filter_by(id=first["id"]).first().status, "canceled")
        board = {c["id"]: c for c in hr.list_candidates(user=HR_USER, db=self.db)}
        self.assertEqual(board[cid]["interview"]["at"], "2026-11-03T17:00:00Z")
        self.assertEqual(board[cid]["interview"]["interviewers"], [HR_USER["email"]])
        hi.cancel_interview(second["id"], user=HR_USER, db=self.db)
        self.assertEqual(self._stage(cid).interview_at, "")

    def test_no_email_no_invite(self):
        cid = self._cand("screening", email="")
        with self.assertRaises(HTTPException) as e:
            self._schedule(cid)
        self.assertIn("email", e.exception.detail)


if __name__ == "__main__":
    unittest.main()
