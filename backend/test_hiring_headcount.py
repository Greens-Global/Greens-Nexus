"""Headcount requests and job openings (Neil, Oct 27 2026) - routers/hiring.py.

The approval chain (the department head's line, then HR++), who may raise,
see and decide, the restricted salary range, the opening an approval makes,
and the last hire filling it.

Run with: python -m unittest test_hiring_headcount -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402

import cache  # noqa: E402
import database  # noqa: E402
import hiring_openings as ho  # noqa: E402
import models  # noqa: E402
from routers import hiring  # noqa: E402
from routers import hr  # noqa: E402

ENT, OTHER = "ent-hc", "ent-hc-other"
MGR = {"email": "maya.mgr@greensglobal.com", "level": 3, "role": "manager"}
HEAD = {"email": "hank.head@greensglobal.com", "level": 3, "role": "manager"}
BOSS = {"email": "bea.boss@greensglobal.com", "level": 3, "role": "manager"}
HRC = {"email": "holly.hr@greensglobal.com", "level": 1, "role": "employee"}
ADMIN = {"email": "ada.admin@greensglobal.com", "level": 4, "role": "administrator"}
OWNER = {"email": "neil@greensglobal.com", "level": 5, "role": "owner"}
EMP = {"email": "evan.emp@greensglobal.com", "level": 1, "role": "employee"}
PAYROLL = {"email": "pat.pay@greensglobal.com", "level": 1, "role": "employee"}


class HeadcountCase(unittest.TestCase):
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
        for m in (models.HrHeadcountRequest, models.HrJobOpening, models.HrCandidate, models.HrStageEvent,
                  models.NexusGroup, models.NexusGroupMember, models.HrEntity, models.HrDepartment,
                  models.NexusEmployee, models.NexusNotification, models.NexusRole, models.Task):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=ENT, name="Hire Co", country="US", hr_contact_email=HRC["email"],
                                    created_at="2026-01-01"))
        self.db.add(models.HrEntity(id=OTHER, name="Other Co", created_at="2026-01-02"))
        self.db.add(models.HrDepartment(id="d-acct", company_id=ENT, name="Accounting", lead_email=HEAD["email"]))
        self.db.add(models.NexusGroup(id="role-acct", name="Staff Accountant", department="Accounting",
                                      is_job_role=1, company_id=ENT, job_description="Close the books.\n\n- Reconcile"))
        self.db.add(models.NexusGroup(id="role-ops", name="Site Lead", department="Operations",
                                      is_job_role=1, company_id=ENT))
        for i, (u, mgr) in enumerate(((MGR, BOSS), (HEAD, BOSS), (BOSS, ""), (HRC, ""), (ADMIN, ""),
                                       (OWNER, ""), (EMP, MGR), (PAYROLL, ""))):
            first = u["email"].split("@")[0].split(".")[0].title()
            self.db.add(models.NexusEmployee(id=f"e{i}", work_email=u["email"], first_name=first, last_name="T",
                                             company=ENT, status="active", manager_email=mgr["email"] if mgr else ""))
        self.db.add(models.NexusRole(email=OWNER["email"], role="owner"))
        # Holly (the HR contact) edits People; Pat holds Pay & Benefits.
        self.db.add(models.NexusGroup(id="g-hr", name="HR", allowed_modules="hr:editor"))
        self.db.add(models.NexusGroupMember(group_id="g-hr", email=HRC["email"]))
        self.db.add(models.NexusGroup(id="g-pay", name="Payroll", allowed_modules="hr_comp:viewer,hr:full"))
        self.db.add(models.NexusGroupMember(group_id="g-pay", email=PAYROLL["email"]))
        self.db.commit()
        cache.module_grants.invalidate()

    def tearDown(self):
        self.db.close()

    def _new(self, user=MGR, **kw):
        body = {"company": ENT, "role_id": "role-acct", "employment_type": "full_time", "openings": 1,
                "justification": "Month-end volume doubled.", "submit": True}
        body.update(kw)
        return hiring.create_headcount(hiring.HeadcountIn(**body), user=user, db=self.db)

    def _decide(self, rid, user, decision="approve", note=""):
        return hiring.decide_headcount(rid, hiring.DecideIn(decision=decision, note=note), user=user, db=self.db)

    def _bells(self, email):
        self.db.expire_all()
        return self.db.query(models.NexusNotification).filter(models.NexusNotification.recipient == email).all()

    def _status(self, rid, user=OWNER):
        return next(r for r in hiring.list_headcount(user=user, db=self.db) if r["id"] == rid)


class ApprovalChainTests(HeadcountCase):
    def test_an_employee_cannot_raise_one(self):
        with self.assertRaises(HTTPException) as e:
            self._new(user=EMP)
        self.assertEqual(e.exception.status_code, 403)

    def test_department_line_then_hr_then_an_opening(self):
        r = self._new()
        self.assertEqual(r["status"], "awaiting_approval")
        self.assertEqual(r["step"], "department")
        self.assertEqual([a["email"] for a in r["deptApprovers"]], [HEAD["email"], BOSS["email"]])
        self.assertTrue(r["code"].startswith("HC-"))
        self.assertEqual(len(self._bells(HEAD["email"])), 1)
        self.assertEqual(len(self._bells(BOSS["email"])), 1)
        self.assertEqual(self._bells(HRC["email"]), [])
        # HR cannot jump the department.
        with self.assertRaises(HTTPException) as e:
            self._decide(r["id"], HRC)
        self.assertEqual(e.exception.status_code, 403)
        # Someone outside it does not even see it.
        with self.assertRaises(HTTPException) as e:
            self._decide(r["id"], EMP)
        self.assertEqual(e.exception.status_code, 404)
        self.assertEqual(hiring.list_headcount(user=EMP, db=self.db), [])

        r = self._decide(r["id"], BOSS)       # anyone in the line is enough
        self.assertEqual((r["status"], r["step"]), ("awaiting_approval", "hr"))
        self.assertEqual(len(self._bells(HRC["email"])), 1)
        self.assertTrue(any("Approved By The Department" in n.title for n in self._bells(MGR["email"])))
        # The head's bell for the department step is done.
        self.assertTrue(all(n.actioned for n in self._bells(HEAD["email"])))

        r = self._decide(r["id"], HRC)
        self.assertEqual(r["status"], "approved")
        self.assertTrue(r["openingId"])
        self.db.expire_all()
        op = self.db.query(models.HrJobOpening).filter_by(id=r["openingId"]).first()
        self.assertEqual((op.status, op.title, op.department, op.seats), ("draft", "Staff Accountant", "Accounting", 1))
        self.assertEqual(op.hiring_owner_email, MGR["email"])
        self.assertIn("Close the books.", op.description)     # the role's job description to start from
        self.assertFalse(op.show_pay)
        # The requester has ONE bell for the request, rewritten in place.
        mine = [n for n in self._bells(MGR["email"]) if n.ref_id == f"headcount:{r['id']}"]
        self.assertEqual(len(mine), 1)
        self.assertIn("Approved", mine[0].title)

    def test_raised_by_the_departments_own_line_goes_straight_to_hr(self):
        r = self._new(user=HEAD)
        self.assertEqual(r["step"], "hr")
        self.assertEqual(r["deptDecidedBy"], HEAD["email"])
        self.assertEqual(len(self._bells(HRC["email"])), 1)

    def test_nobody_approves_their_own_request_at_the_hr_step(self):
        r = self._new(user=HRC)                 # HR raises it (a People editor)
        r = self._decide(r["id"], HEAD)
        self.assertEqual(r["step"], "hr")
        self.assertFalse(r["canDecide"])
        with self.assertRaises(HTTPException) as e:
            self._decide(r["id"], HRC)
        self.assertEqual(e.exception.status_code, 403)
        # The requester is the HR contact, so the Global Admins are asked instead.
        self.assertTrue(self._bells(OWNER["email"]))
        self.assertEqual(self._decide(r["id"], ADMIN)["status"], "approved")   # an administrator is HR++

    def test_a_full_people_grant_is_hr_plus_plus(self):
        r = self._new()
        self._decide(r["id"], HEAD)
        self.assertEqual(self._decide(r["id"], PAYROLL)["status"], "approved")

    def test_decline_needs_a_reason_and_the_request_can_go_again(self):
        r = self._new()
        with self.assertRaises(HTTPException) as e:
            self._decide(r["id"], HEAD, "decline")
        self.assertEqual(e.exception.status_code, 400)
        r = self._decide(r["id"], HEAD, "decline", "No budget this quarter")
        self.assertEqual((r["status"], r["declineNote"]), ("declined", "No budget this quarter"))
        self.assertTrue(any("Declined" in n.title for n in self._bells(MGR["email"])))
        with self.assertRaises(HTTPException):
            self._decide(r["id"], BOSS)          # decided already
        r = hiring.update_headcount(r["id"], hiring.HeadcountIn(openings=2, submit=True), user=MGR, db=self.db)
        self.assertEqual((r["status"], r["step"], r["openings"], r["declineNote"]), ("awaiting_approval", "department", 2, ""))

    def test_no_department_head_set_up_asks_the_global_admins(self):
        r = self._new(role_id="role-ops")
        self.assertEqual([a["email"] for a in r["deptApprovers"]], [OWNER["email"]])

    def test_a_draft_is_the_requesters_until_it_is_sent(self):
        r = self._new(submit=False)
        self.assertEqual(r["status"], "draft")
        self.assertEqual(self._bells(HEAD["email"]), [])
        self.assertEqual([x["id"] for x in hiring.list_headcount(user=HEAD, db=self.db)], [])
        r = hiring.submit_headcount(r["id"], user=MGR, db=self.db)
        self.assertEqual(r["step"], "department")
        self.assertIn(r["id"], [x["id"] for x in hiring.list_headcount(user=HEAD, db=self.db)])

    def test_missing_fields_block_sending(self):
        with self.assertRaises(HTTPException) as e:
            self._new(role_id="", role_title="", justification="")
        self.assertEqual(e.exception.status_code, 400)
        self.assertIn("Justification", e.exception.detail)

    def test_a_company_outside_the_managers_reach_is_refused(self):
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()
        try:
            with self.assertRaises(HTTPException) as e:
                self._new(company=OTHER, role_id="", role_title="Clerk", department="Ops")
            self.assertEqual(e.exception.status_code, 400)
        finally:
            self.db.query(models.NexusSetting).filter_by(key="company_walls").delete()
            self.db.commit()
            cache.settings_config.invalidate()


class SalaryTests(HeadcountCase):
    def test_the_salary_range_is_for_pay_and_benefits_only(self):
        r = self._new(salary_min=60000, salary_max=75000)
        self.assertTrue(r["hasSalary"])
        self.assertNotIn("salaryMin", r)                       # the manager who gave it cannot read it back
        head_view = self._status(r["id"], user=HEAD)
        self.assertNotIn("salaryMin", head_view)
        self.assertNotIn("salaryMax", head_view)
        pay_view = self._status(r["id"], user=PAYROLL)
        self.assertEqual((pay_view["salaryMin"], pay_view["salaryMax"]), (60000, 75000))
        self.assertEqual(self._status(r["id"], user=OWNER)["salaryMax"], 75000)

    def test_changing_it_later_takes_pay_and_benefits(self):
        r = self._new(salary_min=60000, salary_max=75000, submit=False)
        with self.assertRaises(HTTPException) as e:
            hiring.update_headcount(r["id"], hiring.HeadcountIn(salary_max=1), user=MGR, db=self.db)
        self.assertEqual(e.exception.status_code, 403)
        out = hiring.update_headcount(r["id"], hiring.HeadcountIn(salary_max=80000), user=PAYROLL, db=self.db)
        self.assertEqual(out["salaryMax"], 80000)

    def test_a_backwards_range_is_refused(self):
        with self.assertRaises(HTTPException):
            self._new(salary_min=90000, salary_max=10)


class OpeningTests(HeadcountCase):
    def _opening(self, **kw):
        r = self._new(salary_min=60000, salary_max=75000, **kw)
        self._decide(r["id"], HEAD)
        return self._decide(r["id"], HRC)["openingId"]

    def _patch(self, oid, user=HRC, **kw):
        return hiring.update_opening(oid, hiring.OpeningIn(**kw), user=user, db=self.db)

    def test_opening_it_needs_a_description_and_a_place(self):
        oid = self._opening()
        self._patch(oid, description="")
        with self.assertRaises(HTTPException) as e:
            self._patch(oid, status="open")
        self.assertEqual(e.exception.status_code, 400)
        self._patch(oid, description="Close the books.", city="Austin", region="TX")
        with self.assertRaises(HTTPException):
            self._patch(oid, status="filled")                  # Draft never jumps to Filled
        out = self._patch(oid, status="open")
        self.assertEqual(out["status"], "open")
        self.assertTrue(out["listed"])
        self.assertTrue(out["validThrough"])                   # an end date is set when opened
        self.assertIn("/careers/hire-co/", out["careersUrl"])

    def test_pay_and_its_public_toggle_are_pay_and_benefits_only(self):
        oid = self._opening()
        self.assertNotIn("payMin", hiring.get_opening(oid, user=HRC, db=self.db))
        with self.assertRaises(HTTPException) as e:
            self._patch(oid, show_pay=True)
        self.assertEqual(e.exception.status_code, 403)
        out = self._patch(oid, user=PAYROLL, show_pay=True)
        self.assertTrue(out["showPay"])
        # Once it is public it is no secret on the opening.
        self.assertEqual(hiring.get_opening(oid, user=HRC, db=self.db)["payText"], "$60,000 - $75,000 per year")

    def test_people_readers_only(self):
        with self.assertRaises(HTTPException):
            hiring.list_openings(user=MGR, db=self.db)          # a manager tier, even with People, is team-only
        self.assertEqual(len(hiring.list_openings(user=HRC, db=self.db)), 0)
        self._opening()
        self.assertEqual(len(hiring.list_openings(user=HRC, db=self.db)), 1)

    def test_the_hiring_owner_comes_from_nexus_people(self):
        oid = self._opening()
        with self.assertRaises(HTTPException):
            self._patch(oid, hiring_owner_email="stranger@gmail.com")
        self.assertEqual(self._patch(oid, hiring_owner_email=HEAD["email"])["hiringOwnerEmail"], HEAD["email"])

    def test_candidates_link_to_an_opening_of_their_company_only(self):
        oid = self._opening()
        c = hr.create_candidate(hr.CandidateIn(first_name="Jo", last_name="Lee", email="jo@gmail.com",
                                               phone="555-0100", company=ENT, opening_id=oid), user=OWNER, db=self.db)
        self.assertEqual((c["openingId"], c["roleTitle"], c["department"]), (oid, "Staff Accountant", "Accounting"))
        with self.assertRaises(HTTPException):
            hr.create_candidate(hr.CandidateIn(first_name="Al", last_name="Bo", email="al@gmail.com", phone="555-0101",
                                               company=OTHER, role_title="Clerk", opening_id=oid), user=OWNER, db=self.db)
        counts = hiring.get_opening(oid, user=HRC, db=self.db)["counts"]
        self.assertEqual((counts["total"], counts.get("applied")), (1, 1))
        opts = hr.hiring_options(company_id=ENT, user=OWNER, db=self.db)
        self.assertEqual([o["id"] for o in opts["openings"]], [oid])

    def test_the_last_seat_taken_marks_it_filled(self):
        oid = self._opening(openings=2)
        self._patch(oid, description="Close the books.", city="Austin", region="TX", status="open")
        cands = []
        for i in range(2):
            cand = models.HrCandidate(id=f"c{i}", first_name=f"P{i}", last_name="Q", company=ENT, opening_id=oid,
                                      stage="offer", created_at="2026-10-01")
            self.db.add(cand)
            cands.append(cand)
        self.db.commit()
        self.assertIsNone(ho.seat_filled(self.db, cands[0], OWNER["email"]))     # 1 of 2
        cands[0].stage = "hired"
        self.db.commit()
        op = ho.seat_filled(self.db, cands[1], OWNER["email"])                   # 2 of 2
        self.db.commit()
        self.assertIsNotNone(op)
        self.assertEqual(op.status, "filled")
        self.assertFalse(ho.is_listed(op))
        self.assertTrue(any("Opening Filled" in n.title for n in self._bells(MGR["email"])))

    def test_marking_the_hire_in_the_pipeline_fills_it(self):
        oid = self._opening()
        self._patch(oid, description="Close the books.", city="Austin", region="TX", status="open")
        c = hr.create_candidate(hr.CandidateIn(first_name="Jo", last_name="Lee", email="jo@gmail.com",
                                               phone="555-0100", company=ENT, opening_id=oid), user=OWNER, db=self.db)
        self.db.query(models.HrCandidate).filter_by(id=c["id"]).update({"stage": "offer"})
        self.db.commit()
        hr.update_candidate(c["id"], hr.CandidateUpdate(stage="hired", stage_note="Signed on paper"),
                            user=OWNER, db=self.db)
        self.db.expire_all()
        self.assertEqual(self.db.query(models.HrJobOpening).filter_by(id=oid).first().status, "filled")


if __name__ == "__main__":
    unittest.main()
