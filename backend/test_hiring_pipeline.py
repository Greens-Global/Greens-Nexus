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
        self.recorded, self.files = [], {}      # auto-record calls; hr-docs objects written
        self.record_problem = ""
        self._real_meet, self._real_cancel = hi._graph_create_meeting, hi._graph_cancel_meeting
        self._real_enable, self._real_put = hi._graph_enable_recording, hi._put_file

        def enable(iv):
            self.recorded.append(iv.join_url)
            return self.record_problem
        hi._graph_enable_recording = enable
        hi._put_file = lambda path, content, ctype: self.files.__setitem__(path, (len(content), ctype))

        def meet(*a, **k):
            self.invites.append((a, k))
            return {"eventId": f"ev{len(self.invites)}", "joinUrl": "https://teams/x"}

        def cancel(org, ev):
            self.invites.append(("cancel", ev))
            return ""
        hi._graph_create_meeting, hi._graph_cancel_meeting = meet, cancel

    def tearDown(self):
        hi._graph_create_meeting, hi._graph_cancel_meeting = self._real_meet, self._real_cancel
        hi._graph_enable_recording, hi._put_file = self._real_enable, self._real_put
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

    def test_scheduling_turns_auto_recording_on(self):
        cid = self._cand("screening")
        out = self._schedule(cid)
        self.assertEqual((out["autoRecord"], self.recorded), ("on", ["https://teams/x"]))
        notes = [e.note for e in self.db.query(models.HrStageEvent).filter_by(candidate_id=cid).all()]
        self.assertTrue(any("auto-recording on" in n for n in notes))

    def test_auto_recording_that_cannot_be_turned_on_does_not_stop_the_interview(self):
        self.record_problem = "Graph denied changing the meeting"
        cid = self._cand("screening")
        out = self._schedule(cid)
        self.assertTrue(out["autoRecord"].startswith("failed: Graph denied"))
        self.assertEqual(self._stage(cid).stage, "interview")

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


class FollowupTests(PipelineCase):
    """End Interview merges everything (Neil: "when we clicked end, it should
    just take all of this stuff in and merge it all"); the transcript can be
    late, so Nexus keeps trying."""

    def setUp(self):
        super().setUp()
        self.db.add(models.HrInterviewTemplate(id="q-gen", name="General", is_general=True,
                                               questions=[{"id": "q1", "q": "Last role?"}, {"id": "q2", "q": "Why us?"}]))
        self.db.commit()
        self.cid = self._cand("screening")
        self.iv = self._schedule(self.cid, interviewer_emails=[NEIL])
        self.transcript_ready = False
        self.recording_ready = False
        self.claude_calls = []
        self._real_fetch, self._real_claude = hi._fetch_transcript, hi._claude
        self._real_fetch_rec = hi._fetch_recording

        def fetch(db, iv):
            if not self.transcript_ready:
                raise HTTPException(404, "No transcript yet")
            iv.transcript = "WEBVTT\n\nJane: I ran month-end close. I like your projects."
            hi._save_transcript_file(db, iv)

        def fetch_rec(db, iv):
            if not self.recording_ready:
                raise HTTPException(404, "No recording yet")
            iv.recording_path, iv.recording_size = f"interviews/{iv.id}/recording.mp4", 123456
            hi._attach_to_employee(db, iv)
        hi._fetch_recording = fetch_rec

        def claude(prompt, max_tokens=3000):
            self.claude_calls.append(prompt)
            if "transcribing" in prompt:
                return '[{"qid": "q1", "answer": "AI: month-end close"}, {"qid": "q2", "answer": "AI: likes the projects"}]'
            return '{"scores": [{"qid": "q1", "score": 7, "rationale": "ok"}, {"qid": "q2", "score": 6, "rationale": "ok"}], "total": 68, "summary": "Solid."}'
        hi._fetch_transcript, hi._claude = fetch, claude

    def tearDown(self):
        hi._fetch_transcript, hi._claude = self._real_fetch, self._real_claude
        hi._fetch_recording = self._real_fetch_rec
        super().tearDown()

    def _rec_step(self):
        iv = self.db.query(models.HrInterview).filter_by(id=self.iv["id"]).first()
        hi.recording_step(self.db, iv)
        self.db.commit()
        self.db.expire_all()
        return self.db.query(models.HrInterview).filter_by(id=self.iv["id"]).first()

    def test_the_recording_is_pulled_and_lands_on_the_employee_once_hired(self):
        out = self._finish([])
        self.assertEqual(out["recordingStatus"], "waiting")
        iv = self._rec_step()                               # not published yet
        self.assertEqual((iv.recording_status, iv.recording_attempts), ("waiting", 1))
        self.transcript_ready = True
        self._step()                                        # transcript -> file saved
        iv = self.db.query(models.HrInterview).filter_by(id=self.iv["id"]).first()
        self.assertEqual(iv.transcript_path, f"interviews/{iv.id}/transcript.vtt")
        self.assertIn(iv.transcript_path, self.files)
        self.recording_ready = True
        iv = self._rec_step()
        self.assertEqual((iv.recording_status, iv.recording_path), ("done", f"interviews/{iv.id}/recording.mp4"))
        self.assertTrue(any("recording saved" in n.title.lower() for n in
                            self.db.query(models.NexusNotification).filter_by(recipient=NEIL).all()))
        # Not an employee yet - nothing on a profile. Hire -> both files on their Documents.
        self.assertEqual(self.db.query(models.HrDocument).filter(
            models.HrDocument.storage_path.in_([iv.recording_path, iv.transcript_path])).count(), 0)
        cand = self.db.query(models.HrCandidate).filter_by(id=self.cid).first()
        emp = hr.create_employee_from_candidate(self.db, cand, HR_USER["email"])
        self.db.commit()
        docs = {d.file_name: d.storage_path for d in self.db.query(models.HrDocument).filter_by(employee_id=emp.id).all()}
        self.assertEqual(set(docs.values()), {iv.recording_path, iv.transcript_path})
        self.assertTrue(all(n.startswith("Interview 11/02/2026 - ") for n in docs))
        # Hiring again never duplicates; the profile lists the round with its files.
        hi.attach_interview_files(self.db, cand)
        self.assertEqual(self.db.query(models.HrDocument).filter_by(employee_id=emp.id).count(), 2)
        rows = hi.employee_interviews(emp.id, user=HR_USER, db=self.db)
        self.assertEqual((len(rows), rows[0]["hasRecording"], rows[0]["hasTranscriptFile"]), (1, True, True))

    def test_a_recording_that_arrives_after_the_hire_still_lands_on_the_profile(self):
        cand = self.db.query(models.HrCandidate).filter_by(id=self.cid).first()
        emp = hr.create_employee_from_candidate(self.db, cand, HR_USER["email"])
        self.db.commit()
        self._finish([])
        self.recording_ready = True
        self._rec_step()
        self.assertEqual([d.file_name for d in self.db.query(models.HrDocument).filter_by(employee_id=emp.id).all()],
                         ["Interview 11/02/2026 - Recording.mp4"])

    def test_recording_setup_problem_fails_with_the_reason(self):
        hi._fetch_recording = lambda db, iv: (_ for _ in ()).throw(HTTPException(502, "Graph denied reading the recording"))
        self._finish([])
        iv = self._rec_step()
        self.assertEqual(iv.recording_status, "failed")
        self.assertIn("Graph denied", iv.recording_note)

    def _finish(self, answers):
        return hi.finish_interview(self.iv["id"], hi.FinishIn(answers=answers), user=HR_USER, db=self.db)

    def _step(self):
        iv = self.db.query(models.HrInterview).filter_by(id=self.iv["id"]).first()
        hi.followup_step(self.db, iv)
        self.db.commit()
        self.db.expire_all()
        return self.db.query(models.HrInterview).filter_by(id=self.iv["id"]).first()

    def test_end_waits_for_the_transcript_then_fills_only_blanks_and_scores(self):
        typed = [{"qid": "q1", "q": "Last role?", "answer": "Typed: ran the close", "score": None, "rationale": ""},
                 {"qid": "q2", "q": "Why us?", "answer": "", "score": None, "rationale": ""}]
        out = self._finish(typed)
        self.assertEqual((out["status"], out["followupStatus"]), ("completed", "waiting"))
        iv = self._step()                                   # Teams has not published yet
        self.assertEqual(iv.followup_status, "waiting")
        self.assertGreater(iv.followup_next_at, out["createdAt"])
        self.transcript_ready = True
        iv = self._step()
        self.assertEqual((iv.status, iv.followup_status, iv.total_score), ("scored", "done", 68.0))
        answers = {a["qid"]: a["answer"] for a in iv.answers}
        self.assertEqual(answers, {"q1": "Typed: ran the close", "q2": "AI: likes the projects"})
        self.assertTrue(any("Interview scored" in n.title for n in
                            self.db.query(models.NexusNotification).filter_by(recipient=NEIL).all()))

    def test_a_setup_problem_still_scores_the_typed_answers(self):
        hi._fetch_transcript = lambda db, iv: (_ for _ in ()).throw(HTTPException(502, "Graph denied reading the meeting"))
        self._finish([{"qid": "q1", "q": "Last role?", "answer": "Typed", "score": None, "rationale": ""}])
        iv = self._step()
        self.assertEqual((iv.status, iv.followup_status), ("scored", "done"))
        self.assertIn("Graph denied", iv.followup_note)

    def test_nothing_to_score_fails_with_a_reason_after_the_retries(self):
        self._finish([])
        for _ in range(len(hi.FOLLOWUP_BACKOFF_MIN) + 1):
            iv = self._step()
        self.assertEqual(iv.followup_status, "failed")
        self.assertIn("paste the transcript", iv.followup_note)


if __name__ == "__main__":
    unittest.main()
