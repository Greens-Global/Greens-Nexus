"""Exits In Progress and the final settlement statement (Neil, Oct 27 2026)
- exit_statement.py + routers/exit_statements.py.

  * the list holds people with a separation in progress (or marked Left)
    until HR closes the exit, inside the People scope
  * the statement adds up the final Time Sheet, leave per bucket, approved
    reimbursements not paid, the salary advance to recover, items held and
    the offboarding checklist
  * leave is use it or lose it - "Not Paid Out (Company Policy)" - except
    California VACATION, paid out at the hourly rate and flagged "Required By
    California Law"; California sick is not paid out
  * money only for hr_comp / owners; review and the PDF need it too; a
    change after review makes the review stale; the PDF is kept as a
    comp-gated HR document

    python -m unittest test_exit_statements
"""
import unittest
from datetime import date, timedelta

from fastapi import HTTPException

from test_timesheet_review import ReviewCase, EMP, MGR, HR, ENTITY, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import auth  # noqa: E402
import exit_statement as xs  # noqa: E402
import leave_balances  # noqa: E402
import models  # noqa: E402
from routers import exit_statements as api, hr as hr_router  # noqa: E402

OWNER = {"email": "owner.exit@greensglobal.com", "level": 5}       # sees pay
ADMIN = {"email": "admin.exit@greensglobal.com", "level": 4}       # People, no pay grant
MANAGER = {"email": MGR, "level": 3}                               # team view of People


class ExitCase(ReviewCase):
    def setUp(self):
        super().setUp()
        for m in (models.ExitStatement, models.HrLifeEvent, models.ExpenseReimbursement, models.SalaryAdvance,
                  models.SalaryAdvanceInstallment, models.HrChecklist, models.HrChecklistItem, models.Item,
                  models.HrDocument, models.LeaveLedgerEntry, models.NexusSetting, models.NexusNotification,
                  models.ItemCheckout):
            self.db.query(m).delete()
        emp = self.db.query(models.NexusEmployee).filter_by(work_email=EMP).one()
        emp.country, emp.employment_type, emp.job_title = "US", "full_time", "Site Lead"
        emp.start_date = (date.today() - timedelta(days=800)).isoformat()
        self.emp_id = emp.id
        self.db.add(models.PayrollRate(employee_email=EMP, hourly_rate=20.0, overtime_rule="ca", pay_type="hourly",
                                       currency="USD"))
        self.last_day = self.end
        self.db.add(models.HrLifeEvent(id="sep-1", kind="separation", status="completed", entity_id=ENTITY,
                                       employee_id=emp.id, subject_name="Erin Test", subject_email=EMP,
                                       inputs={"last_day": self.last_day, "exit_type": "resignation"},
                                       effective_date=self.last_day, apply_status="scheduled",
                                       created_by=HR, created_at="2026-10-01T00:00:00"))
        self.db.commit()
        cut = (date.today() - timedelta(days=10)).isoformat()
        leave_balances.set_cutover(self.db, cut, HR)
        self.db.commit()
        leave_balances.set_opening(self.db, EMP, 16.0, 8.0, HR)
        self.db.add(models.ExpenseReimbursement(id="rb-1", employee_email=EMP, employee_name="Erin Test",
                                                company=ENTITY, item="Monitor", amount=75.0, currency="USD",
                                                status="hr_approved", approver_email=MGR, history=[],
                                                created_at="2026-10-02T00:00:00"))
        self.db.add(models.ExpenseReimbursement(id="rb-2", employee_email=EMP, employee_name="Erin Test",
                                                company=ENTITY, item="Paid already", amount=40.0, currency="USD",
                                                status="paid", approver_email=MGR, history=[],
                                                created_at="2026-10-02T00:00:00"))
        self.db.add(models.SalaryAdvance(id="adv-1", employee_email=EMP, employee_name="Erin Test", company=ENTITY,
                                         amount=100.0, currency="USD", installments=1, status="paid_out",
                                         paid_on="2026-10-01", history=[], created_at="2026-10-01T00:00:00"))
        self.db.add(models.SalaryAdvanceInstallment(id="inst-1", advance_id="adv-1", employee_email=EMP, seq=1,
                                                    amount=100.0, currency="USD", date="2099-01-01",
                                                    status="scheduled"))
        self.db.add(models.HrChecklist(id="cl-1", employee_id=emp.id, kind="offboarding", company=ENTITY,
                                       status="open", created_at="2026-10-01T00:00:00"))
        self.db.add(models.HrChecklistItem(id="ci-1", checklist_id="cl-1", title="Collect laptop", status="done"))
        self.db.add(models.HrChecklistItem(id="ci-2", checklist_id="cl-1", title="Final pay", status="open",
                                           due_date="2000-01-01"))
        self.db.add(models.HrChecklistItem(id="ci-3", checklist_id="cl-1", title="Not needed", status="na"))
        self.db.add(models.Item(id="it-1", name="Laptop", serial_number="SN-9", assigned_to_email=EMP,
                                status="permanently_assigned"))
        self.db.commit()
        auth.invalidate_role_cache()

    def _st(self, who=OWNER):
        self.db.expire_all()
        return api.get_statement(self.emp_id, user=who, db=self.db)

    def _status(self, code, fn, *a, **k):
        with self.assertRaises(HTTPException) as e:
            fn(*a, **k)
        self.assertEqual(e.exception.status_code, code, e.exception.detail)
        return e.exception.detail


class ListTests(ExitCase):
    def test_leavers_are_listed_until_closed(self):
        rows = api.list_exits(user=OWNER, db=self.db)["exits"]
        self.assertEqual([(r["email"], r["stage"], r["lastDay"], r["exitTypeLabel"]) for r in rows],
                         [(EMP, "Leaving", self.last_day, "Voluntary Resignation")])
        # Marked Left on People with no separation event: listed too.
        mgr = self.db.query(models.NexusEmployee).filter_by(work_email=MGR).one()
        mgr.status = "offboarded"
        mgr.status_log = [{"from": "active", "to": "offboarded", "effectiveDate": date.today().isoformat()}]
        self.db.commit()
        self.assertEqual(len(api.list_exits(user=OWNER, db=self.db)["exits"]), 2)
        # Closed (a note: the statement was never filed) - off the list.
        api.close(self.emp_id, api.NoteIn(note="Handled by payroll"), user=OWNER, db=self.db)
        self.assertEqual([r["email"] for r in api.list_exits(user=OWNER, db=self.db)["exits"]], [MGR])
        self.assertEqual(len(api.list_exits(include_closed=True, user=OWNER, db=self.db)["exits"]), 2)

    def test_the_team_view_never_sees_exits(self):
        self._status(403, api.list_exits, user=MANAGER, db=self.db)
        self._status(403, api.get_statement, self.emp_id, user=MANAGER, db=self.db)


class StatementTests(ExitCase):
    def test_it_adds_up(self):
        out = self._st()
        st = out["statement"]
        self.assertTrue(out["canSeeMoney"])
        self.assertEqual((st["lastDay"], st["stage"], st["companyName"]), (self.last_day, "Leaving", "Greens Test Co"))
        ts = st["timesheet"]
        self.assertEqual((ts["periodStart"], ts["periodEnd"], ts["finalized"], ts["statusLabel"]),
                         (self.start, self.end, False, "Not Submitted"))
        self.assertEqual((ts["link"]["sub"], ts["link"]["timecard"]), ("hr-time", EMP))
        self.assertEqual(st["finalPay"]["grossPay"], 140.0)                       # 7 h at $20
        self.assertEqual([(r["item"], r["amount"]) for r in st["reimbursements"]["owed"]], [("Monitor", 75.0)])
        self.assertEqual([a["balance"] for a in st["advances"]["toRecover"]], [100.0])
        self.assertEqual([(x["name"], x["serial"]) for x in st["items"]["held"]], [("Laptop", "SN-9")])
        cl = st["checklist"]
        self.assertEqual((cl["done"], cl["total"], cl["overdue"]), (1, 2, 1))
        self.assertEqual(st["summary"], {"owedToEmployee": {"USD": 395.0}, "toRecover": {"USD": 100.0}})

    def test_california_vacation_is_paid_out_sick_is_not(self):
        lv = self._st()["statement"]["leave"]
        self.assertEqual(lv["state"], "CA")
        by = {b["bucket"]: b for b in lv["buckets"]}
        self.assertEqual((by["vacation"]["hours"], by["vacation"]["days"], by["vacation"]["payout"]),
                         (16.0, 2.0, "Required By California Law"))
        self.assertEqual(by["sick"]["payout"], xs.NOT_PAID)
        self.assertEqual([(p["label"], p["flag"], p["hours"], p["rate"], p["amount"]) for p in lv["payouts"]],
                         [("Vacation Payout", "Required By California Law", 16.0, 20.0, 320.0)])

    def test_everyone_else_is_use_it_or_lose_it(self):
        rate = self.db.query(models.PayrollRate).filter_by(employee_email=EMP).one()
        rate.overtime_rule = "federal"
        self.db.commit()
        lv = self._st()["statement"]["leave"]
        self.assertEqual(lv["payouts"], [])
        self.assertEqual({b["payout"] for b in lv["buckets"]}, {xs.NOT_PAID})
        # Another state on the list would be paid out (the constant is the switch).
        ent = self.db.query(models.HrEntity).filter_by(id=ENTITY).one()
        ent.region = "MT"
        self.db.commit()
        xs.PAYOUT_REQUIRED_STATES["MT"] = "Required By Montana Law"
        try:
            self.assertEqual(self._st()["statement"]["leave"]["payouts"][0]["flag"], "Required By Montana Law")
        finally:
            xs.PAYOUT_REQUIRED_STATES.pop("MT", None)

    def test_money_only_for_the_pay_grant(self):
        out = self._st(ADMIN)
        st = out["statement"]
        self.assertFalse(out["canSeeMoney"])
        self.assertIsNone(st["finalPay"])
        self.assertNotIn("amount", st["reimbursements"]["owed"][0])
        self.assertNotIn("balance", st["advances"]["toRecover"][0])
        self.assertNotIn("amount", st["leave"]["payouts"][0])
        self.assertEqual(st["leave"]["payouts"][0]["flag"], "Required By California Law")   # the rule still shows
        self.assertEqual(st["summary"], {"owedToEmployee": {}, "toRecover": {}})
        self._status(403, api.review, self.emp_id, api.NoteIn(), user=ADMIN, db=self.db)
        self._status(403, api.generate, self.emp_id, user=ADMIN, db=self.db)


class ReviewTests(ExitCase):
    def test_review_generate_and_stale(self):
        self._status(409, api.generate, self.emp_id, user=OWNER, db=self.db)          # not reviewed yet
        r = api.review(self.emp_id, api.NoteIn(note="Checked"), user=OWNER, db=self.db)
        self.assertEqual((r["status"], r["reviewStale"]), ("reviewed", False))
        out = api.generate(self.emp_id, user=OWNER, db=self.db)
        self.assertEqual(out["review"]["status"], "filed")
        doc = self.db.query(models.HrDocument).filter_by(id=out["documentId"]).one()
        self.assertEqual(doc.kind, "settlement")
        self.assertTrue(doc.file_name.endswith("Final Settlement Statement.pdf"))
        # Kept with the person's HR documents - and hidden without the pay grant.
        self.assertEqual([d["kind"] for d in hr_router.list_documents(self.emp_id, user=OWNER, db=self.db)], ["settlement"])
        self.assertEqual(hr_router.list_documents(self.emp_id, user=ADMIN, db=self.db), [])
        self._status(403, hr_router.document_url, doc.id, user=ADMIN, db=self.db)
        # A figure changes after the review: the review is stale and no new PDF until reviewed again.
        self.db.add(models.ExpenseReimbursement(id="rb-3", employee_email=EMP, employee_name="Erin Test",
                                                company=ENTITY, item="Parking", amount=12.0, currency="USD",
                                                status="hr_approved", approver_email=MGR, history=[],
                                                created_at="2026-10-03T00:00:00"))
        self.db.commit()
        self.assertTrue(self._st()["review"]["reviewStale"])
        self.assertTrue(self._st(ADMIN)["review"]["reviewStale"])
        self._status(409, api.generate, self.emp_id, user=OWNER, db=self.db)
        # A checklist tick is not a payroll figure: it never makes the review stale.
        api.review(self.emp_id, api.NoteIn(), user=OWNER, db=self.db)
        self.db.query(models.HrChecklistItem).filter_by(id="ci-2").update({"status": "done"})
        self.db.commit()
        self.assertFalse(self._st()["review"]["reviewStale"])
        # Closed after filing needs no note.
        api.generate(self.emp_id, user=OWNER, db=self.db)
        self.assertEqual(api.close(self.emp_id, api.NoteIn(), user=OWNER, db=self.db)["status"], "closed")

    def test_the_pdf_renders(self):
        st = self._st()["statement"]
        pdf = xs.render_pdf(self.db, st, "Owner Test", "2026-10-27T10:00:00")
        self.assertTrue(pdf.startswith(b"%PDF"))
        body = xs.content(st, "Owner Test", "2026-10-27T10:00:00", False)["body"]["content"]
        text = " ".join(t.get("text", "") for n in body for t in _texts(n))
        self.assertIn("Required By California Law", text)
        self.assertIn("Not Paid Out (Company Policy)", text)
        self.assertIn("Salary Advance To Recover", text)
        self.assertNotIn("Leave Payout - pending policy", text)


def _texts(n):
    if n.get("type") == "text":
        yield n
    for c in n.get("content") or []:
        yield from _texts(c)


if __name__ == "__main__":
    unittest.main()
