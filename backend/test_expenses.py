"""Expense reimbursement (Neil, Oct 17 2026) - routers/expenses.py end to end.

employee submits -> manager sends back -> employee resubmits -> manager
approves -> accounting approves -> accounting marks paid, with the bells at
each step; plus who may see and decide what.

    python -m pytest -q test_expenses.py
"""
import os
import tempfile
import unittest
from datetime import date, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import items  # noqa: E402

EMP, MGR, ACCT, OUTSIDER = ("erin.exp@greensglobal.com", "max.exp@greensglobal.com",
                            "ada.exp@greensglobal.com", "olly.exp@greensglobal.com")
FILE = f"{items._STORAGE_PREFIX or 'https://x.supabase.co/storage/v1/object/public/'}ticket-evidence/expense-1.jpg"


def _claim(**kw):
    body = {"expense_date": (date.today() - timedelta(days=2)).isoformat(), "vendor": "Home Depot",
            "category": "supplies", "amount": 42.5, "description": "Paint for unit 4",
            "receipt_urls": [FILE], "payment_proof_urls": [FILE]}
    body.update(kw)
    return body


class ExpensesCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")
        self.db = database.SessionLocal()
        for m in (models.ExpenseClaim, models.NexusNotification, models.NexusEmployee, models.NexusRole,
                  models.NexusGroup, models.NexusGroupMember):
            self.db.query(m).delete()
        for em, first, mgr in ((EMP, "Erin", MGR), (MGR, "Max", ""), (ACCT, "Ada", ""), (OUTSIDER, "Olly", "")):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=em, first_name=first, last_name="Test",
                                             manager_email=mgr, status="active"))
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        self.db.add(models.NexusRole(email=OUTSIDER, role="manager", assigned_by="test"))
        self.db.add(models.NexusGroup(id="g-acct", name="Accounting", allowed_modules="reimbursements:editor"))
        self.db.add(models.NexusGroupMember(group_id="g-acct", email=ACCT))
        self.db.commit()
        auth._role_cache.clear()

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth._role_cache.clear()
        auth.SKIP_AUTH = self._skip
        self.db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth._role_cache.clear()

    def _call(self, who, method, path, status=200, **kw):
        self._as(who)
        res = getattr(self.client, method)(path, **kw)
        self.assertEqual(res.status_code, status, res.text)
        return res.json()

    def _bells(self, who):
        self.db.expire_all()
        return [n.title for n in self.db.query(models.NexusNotification)
                .filter(models.NexusNotification.recipient == who).all()]

    def test_the_whole_journey(self):
        c = self._call(EMP, "post", "/expenses", 201, json=_claim())
        self.assertEqual((c["status"], c["amount"]), ("submitted", 42.5))
        self.assertIn("Expense Claim", self._bells(MGR))

        # The manager sends it back with a reason; the employee fixes it.
        self._call(MGR, "post", f"/expenses/{c['id']}/manager-decision", 400, json={"action": "send_back"})
        self._call(MGR, "post", f"/expenses/{c['id']}/manager-decision",
                   json={"action": "send_back", "note": "Receipt is cut off"})
        self.assertIn("Expense Claim Sent Back", self._bells(EMP))
        c = self._call(EMP, "put", f"/expenses/{c['id']}", json=_claim(amount=45))
        self.assertEqual((c["status"], c["amount"]), ("submitted", 45))

        self._call(MGR, "post", f"/expenses/{c['id']}/manager-decision", json={"action": "approve"})
        self.assertIn("Expense Claim To Review", self._bells(ACCT))

        # Accounting approves, then pays.
        q = self._call(ACCT, "get", "/expenses/queue?status=manager_approved")
        self.assertTrue(q["canReview"])
        self.assertEqual([x["id"] for x in q["claims"]], [c["id"]])
        self._call(ACCT, "post", f"/expenses/{c['id']}/paid", 409,
                   json={"paid_on": date.today().isoformat(), "payment_method": "ach"})
        self._call(ACCT, "post", f"/expenses/{c['id']}/review", json={"action": "approve"})
        done = self._call(ACCT, "post", f"/expenses/{c['id']}/paid",
                          json={"paid_on": date.today().isoformat(), "payment_method": "ach", "payment_ref": "ACH-77"})
        self.assertEqual((done["status"], done["paymentRef"]), ("paid", "ACH-77"))
        self.assertIn("Expense Claim Paid", self._bells(EMP))
        self.assertEqual([h["action"] for h in done["history"]],
                         ["submitted", "manager_send_back", "resubmitted", "manager_approve",
                          "accounting_approve", "paid"])

    def test_who_sees_and_decides(self):
        c = self._call(EMP, "post", "/expenses", 201, json=_claim())
        self.assertEqual(len(self._call(MGR, "get", "/expenses/team")), 1)
        self.assertEqual(len(self._call(MGR, "get", f"/expenses/team?email={EMP}")), 1)
        # Another manager neither sees nor decides Erin's claim.
        self.assertEqual(self._call(OUTSIDER, "get", "/expenses/team"), [])
        self._call(OUTSIDER, "post", f"/expenses/{c['id']}/manager-decision", 403, json={"action": "approve"})
        # Accounting cannot skip the manager; a plain employee has no queue.
        self._call(ACCT, "post", f"/expenses/{c['id']}/review", 409, json={"action": "approve"})
        self._call(EMP, "get", "/expenses/queue", 403)
        # Only the owner cancels, and only before approval.
        self._call(MGR, "post", f"/expenses/{c['id']}/cancel", 403)
        self.assertEqual(self._call(EMP, "post", f"/expenses/{c['id']}/cancel")["status"], "canceled")

    def test_bad_claims_are_refused(self):
        self._call(EMP, "post", "/expenses", 400, json=_claim(receipt_urls=[]))
        self._call(EMP, "post", "/expenses", 400, json=_claim(payment_proof_urls=[]))
        self._call(EMP, "post", "/expenses", 400, json=_claim(amount=0))
        self._call(EMP, "post", "/expenses", 400, json=_claim(category="yacht"))
        self._call(EMP, "post", "/expenses", 400,
                   json=_claim(expense_date=(date.today() + timedelta(days=3)).isoformat()))
        if items._STORAGE_PREFIX:
            self._call(EMP, "post", "/expenses", 400, json=_claim(receipt_urls=["https://evil.example/r.jpg"]))


if __name__ == "__main__":
    unittest.main()
