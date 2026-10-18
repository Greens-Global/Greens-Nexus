"""
Expense reimbursements (Oct 18 2026): file -> picked approver -> HR (as on
time sheets) -> paid; send back + resubmit, reject, cancel; receipts can come
later; a bell at each step; history on the claim.

Throwaway sqlite. No network (receipt uploads are not exercised - the paths
are staged strings, as the upload endpoint would return them).

Run with: python -m unittest test_reimbursements -v
"""
import os
import tempfile
import unittest
import uuid

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit  # noqa: E402

from fastapi import HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

from routers import reimbursements as rb  # noqa: E402


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


SAGAR = "sagar@example.com"     # files it, reports to NEIL
NEIL = "neil@example.com"       # his manager, the default approver
VISESH = "visesh@example.com"   # another approver Sagar can pick
CHARMI = "charmi@example.com"   # the company's HR contact
OTHER = "other@example.com"     # nobody in this story
CO = "co-test"

EMP = {"email": SAGAR, "level": 1}
MGR = {"email": NEIL, "level": 3}
VIS = {"email": VISESH, "level": 3}
HR = {"email": CHARMI, "level": 1}       # HR by being the HR contact, as on time sheets
STRANGER = {"email": OTHER, "level": 1}
R1 = rb.ReceiptRef(path=f"reimbursements/{SAGAR}/a-receipt.pdf", name="receipt.pdf")


class ReimbursementTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.ExpenseReimbursement, models.NexusNotification, models.NexusEmployee,
                  models.HrEntity, models.NexusRole):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="Greens Global", hr_contact_email=CHARMI))
        for email, mgr in ((SAGAR, NEIL), (NEIL, ""), (VISESH, ""), (CHARMI, NEIL), (OTHER, NEIL)):
            self.db.add(models.NexusEmployee(id=str(uuid.uuid4()), work_email=email, first_name=email.split("@")[0].title(),
                                             last_name="Test", manager_email=mgr, company=CO, status="active"))
        self.db.commit()

    def _file(self, **kw):
        body = dict(item="Monitor", amount=249.99, category="equipment", purchase_date="2026-10-17",
                    vendor="Best Buy", details="Second screen for the home office", receipts=[])
        body.update(kw)
        return rb.create(rb.ClaimIn(**body), user=EMP, db=self.db)

    def _decide(self, rid, user, action="approve", note=""):
        return rb.decide(rid, rb.DecisionIn(action=action, note=note), user=user, db=self.db)

    def _bells(self, email):
        return [n.title for n in self.db.query(models.NexusNotification)
                .filter(models.NexusNotification.recipient == email)
                .order_by(models.NexusNotification.created_at).all()]

    def _err(self, fn, code):
        with self.assertRaises(HTTPException) as cm:
            fn()
        self.assertEqual(cm.exception.status_code, code)

    # ── Filing ─────────────────────────────────────────────────────────────
    def test_the_manager_approves_unless_another_is_picked(self):
        self.assertEqual(self._file()["approverEmail"], NEIL)
        r = self._file(approver_email=VISESH)
        self.assertEqual(r["approverName"], "Visesh Test")
        self.assertEqual(self._bells(VISESH), ["Reimbursement to Approve"])
        self.assertEqual(r["history"][0]["label"], "Submitted")

    def test_bad_claims_are_refused(self):
        self._err(lambda: self._file(item=" "), 400)
        self._err(lambda: self._file(details=""), 400)                 # what it was for
        self._err(lambda: self._file(amount=0), 400)
        self._err(lambda: self._file(category="other"), 400)            # Other needs words
        self._err(lambda: self._file(currency="DOLLARS"), 400)
        self._err(lambda: self._file(purchase_date="2999-01-01"), 400)
        self._err(lambda: self._file(approver_email=SAGAR), 400)
        self._err(lambda: self._file(approver_email="ghost@example.com"), 400)
        self._err(lambda: self._file(receipts=[rb.ReceiptRef(path="reimbursements/other@example.com/x.pdf")]), 400)
        ok = self._file(category="other", category_other="Parking", currency="eur")
        self.assertEqual((ok["categoryOther"], ok["currency"]), ("Parking", "EUR"))

    # ── The whole way, receipt after approval ──────────────────────────────
    def test_approver_then_hr_then_paid(self):
        r = self._file()
        self._err(lambda: self._decide(r["id"], STRANGER), 403)
        self._err(lambda: self._decide(r["id"], HR), 403)                 # not HR's turn yet
        out = self._decide(r["id"], MGR)
        self.assertEqual(out["statusLabel"], "Waiting for Receipt")
        self.assertIn("Reimbursement for HR", self._bells(CHARMI))
        self._err(lambda: self._decide(r["id"], HR), 409)                 # no receipt yet
        out = rb.add_receipts(r["id"], rb.ReceiptsIn(receipts=[R1]), user=EMP, db=self.db)
        self.assertEqual(out["statusLabel"], "With HR")
        self.assertIn("Reimbursement Receipt Added", self._bells(CHARMI))
        self._err(lambda: self._decide(r["id"], MGR), 403)                # the manager is not HR
        out = self._decide(r["id"], HR)
        self.assertEqual(out["status"], "hr_approved")
        self._err(lambda: rb.mark_paid(r["id"], rb.PaidIn(paid_on="2026-10-20", payment_method="cash"), user=HR, db=self.db), 400)
        self._err(lambda: rb.mark_paid(r["id"], rb.PaidIn(paid_on="2026-10-20", payment_method="payroll"), user=MGR, db=self.db), 403)
        out = rb.mark_paid(r["id"], rb.PaidIn(paid_on="2026-10-20", payment_method="payroll", payment_ref="PR-1031"),
                           user=HR, db=self.db)
        self.assertEqual((out["status"], out["paymentRef"]), ("paid", "PR-1031"))
        self.assertEqual(self._bells(SAGAR), ["Reimbursement Approved", "Reimbursement Approved by HR", "Reimbursement Paid"])
        self.assertEqual([h["label"] for h in out["history"]],
                         ["Submitted", "Approved", "Receipt Added", "Approved by HR", "Paid"])

    def test_no_hr_contact_means_the_global_admins(self):
        self.db.query(models.HrEntity).update({"hr_contact_email": ""})
        self.db.add(models.NexusRole(email="owner@example.com", role="owner"))
        self.db.commit()
        r = self._file(receipts=[R1])
        self._decide(r["id"], MGR)
        self.assertEqual(self._bells("owner@example.com"), ["Reimbursement for HR"])
        self.assertEqual(self._bells(CHARMI), [])

    # ── Send back, reject, cancel ──────────────────────────────────────────
    def test_send_back_then_fix_and_resubmit(self):
        r = self._file()
        self._err(lambda: self._decide(r["id"], MGR, "send_back"), 400)   # a note is required
        self._decide(r["id"], MGR, "send_back", "Which store?")
        self.assertIn("Reimbursement Sent Back", self._bells(SAGAR))
        body = rb.ClaimIn(item="Monitor", amount=249.99, category="equipment", vendor="Costco",
                          details="Second screen for the home office", approver_email=VISESH, receipts=[R1])
        self._err(lambda: rb.resubmit(r["id"], body, user=STRANGER, db=self.db), 403)
        out = rb.resubmit(r["id"], body, user=EMP, db=self.db)
        self.assertEqual((out["status"], out["vendor"], out["approverEmail"]), ("submitted", "Costco", VISESH))
        self.assertEqual(self._bells(VISESH), ["Reimbursement Resubmitted"])
        self.assertEqual(len(out["receipts"]), 1)

    def test_hr_can_send_back_or_reject_and_the_approver_hears(self):
        r = self._file(receipts=[R1])
        self._decide(r["id"], MGR)
        out = self._decide(r["id"], HR, "reject", "Personal purchase")
        self.assertEqual(out["status"], "rejected")
        self.assertIn("Reimbursement Rejected by HR", self._bells(NEIL))
        self._err(lambda: self._decide(r["id"], HR), 409)

    def test_cancel_only_before_a_decision(self):
        r = self._file()
        self._err(lambda: rb.cancel(r["id"], user=STRANGER, db=self.db), 403)
        self.assertEqual(rb.cancel(r["id"], user=EMP, db=self.db)["status"], "canceled")
        self.assertIn("Reimbursement Canceled", self._bells(NEIL))
        r2 = self._file()
        self._decide(r2["id"], MGR)
        self._err(lambda: rb.cancel(r2["id"], user=EMP, db=self.db), 409)

    # ── Who sees what ──────────────────────────────────────────────────────
    def test_overview_and_the_people_tab(self):
        r = self._file(receipts=[R1])
        self._decide(r["id"], MGR)
        self.assertEqual([x["id"] for x in rb.overview(user=EMP, db=self.db)["mine"]], [r["id"]])
        self.assertFalse(rb.overview(user=EMP, db=self.db)["canHr"])
        self.assertEqual([x["id"] for x in rb.overview(user=MGR, db=self.db)["toApprove"]], [r["id"]])
        hr = rb.overview(user=HR, db=self.db)
        self.assertTrue(hr["canHr"])
        self.assertEqual([x["id"] for x in hr["hr"]], [r["id"]])
        # People > person > Expenses: the person, their manager, HR - not anyone else.
        for u in (EMP, MGR, HR):
            self.assertEqual(len(rb.for_person(SAGAR, user=u, db=self.db)), 1)
        self._err(lambda: rb.for_person(SAGAR, user=STRANGER, db=self.db), 404)

    def test_hr_never_decides_their_own(self):
        r = rb.create(rb.ClaimIn(item="Chair", amount=90, category="equipment", details="Desk chair",
                                 receipts=[rb.ReceiptRef(path=f"reimbursements/{CHARMI}/c.pdf")]), user=HR, db=self.db)
        self._decide(r["id"], MGR)
        self._err(lambda: self._decide(r["id"], HR), 403)
        self.assertEqual(rb.overview(user=HR, db=self.db)["hr"], [])


if __name__ == "__main__":
    unittest.main()
