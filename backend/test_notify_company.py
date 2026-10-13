"""Broadcast notifications carry the company of the person they are about.

A bell row with a blank recipient goes to every manager. Once the company
walls are armed, `routers/notifications.py` shows a broadcast only to managers
whose scope holds its `company` - so a broadcast written with no company is
seen by Global Admins and nobody else. Four modules can write one (Knowledge
Base course completions, the Credential Vault, purchase requisitions with no
approver picked, Investor Relations); each has to stamp it.

The other half: a person with no company (external, untagged, unknown) gets
'' - the value the column always had - and a failed lookup never raises,
because a notification must not break the action that set it off.

Run with: python -m unittest test_notify_company -v
"""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database
import models
from notify_company import notification_company
from routers import credvault, investor_relations, knowledge_base, requisitions


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(
            f"{__name__} deletes rows and is pointed at {actual!r}, not its own "
            f"temp database. Another test module imported `database` first. "
            f"Run it on its own: python -m unittest {__name__}"
        )


_assert_isolated()

ACME = "dean@greensglobal.com"       # an employee of company "acme"
GLOBEX = "miranda@greensglobal.com"  # an employee of company "globex"
UNTAGGED = "sam@greensglobal.com"    # an employee row with no company
STRANGER = "vendor@example.com"      # no employee row at all


class _BrokenDb:
    """A session whose every query blows up."""
    def query(self, *a, **k):
        raise RuntimeError("database is gone")


class NotifyCompanyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        db = database.SessionLocal()
        try:
            for i, (email, company) in enumerate([(ACME, "acme"), (GLOBEX, "globex"), (UNTAGGED, "")]):
                db.add(models.NexusEmployee(id=f"emp-{i}", first_name=email.split("@")[0],
                                            work_email=email, company=company))
            # Administrator: clears the vault's write gate without a module grant.
            db.add(models.NexusRole(email=ACME, role="administrator"))
            db.commit()
        finally:
            db.close()

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.unlink(_tmp_db.name)
        except OSError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.NexusNotification).delete()
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _only(self, ntype):
        rows = self.db.query(models.NexusNotification).filter(models.NexusNotification.type == ntype).all()
        self.assertEqual(len(rows), 1, f"expected one {ntype} row, found {len(rows)}")
        return rows[0]

    # ── the helper ──────────────────────────────────────────────────────────
    def test_first_email_with_a_company_wins(self):
        self.assertEqual(notification_company(self.db, ACME, GLOBEX), "acme")
        self.assertEqual(notification_company(self.db, ACME.upper()), "acme")

    def test_falls_back_to_the_recipient(self):
        self.assertEqual(notification_company(self.db, "", GLOBEX), "globex")
        self.assertEqual(notification_company(self.db, STRANGER, GLOBEX), "globex")
        self.assertEqual(notification_company(self.db, "Dean Winchester", GLOBEX), "globex")

    def test_nobody_known_is_blank_as_before(self):
        for emails in [(), ("",), (None,), ("", ""), (STRANGER,), (UNTAGGED,), (STRANGER, UNTAGGED, "")]:
            self.assertEqual(notification_company(self.db, *emails), "", emails)

    def test_a_failed_lookup_never_raises(self):
        self.assertEqual(notification_company(_BrokenDb(), ACME, GLOBEX), "")

    # ── the four paths that can broadcast ───────────────────────────────────
    def test_kb_course_completion_broadcast(self):
        self.db.add(models.KbCourse(
            id="course-1", course_code="LRN-001", title="Ladder Safety", status="published",
            lessons=json.dumps([{"_id": "l1", "type": "reading", "title": "Read", "body": "x"}]),
            quiz=json.dumps({"passPct": 80, "questions": [
                {"_id": "q1", "q": "Three points of contact?", "options": ["Yes", "No"], "answer": 0}]})))
        self.db.commit()
        out = knowledge_base.submit_quiz("course-1", knowledge_base.QuizSubmitIn(answers={"q1": 0}),
                                         user={"email": GLOBEX, "level": 1}, db=self.db)
        self.assertTrue(out["passed"])
        row = self._only("kb_course_complete")
        self.assertEqual(row.recipient, "")
        self.assertEqual(row.company, "globex")

    def test_credential_vault_broadcast(self):
        credvault.create_credential(
            credvault.CredentialIn(name="Router Admin", dept="IT", secret="Tr0ub4dor&3-horse-staple"),
            user={"email": ACME, "level": 4}, db=self.db)
        row = self._only("vault_change")
        self.assertEqual(row.recipient, "")
        self.assertEqual(row.company, "acme")

    def test_credential_vault_targeted_falls_back_to_recipient(self):
        credvault._notify(self.db, type="vault_access", recipient=GLOBEX, title="t", body="b",
                          actor=STRANGER)
        self.db.commit()
        self.assertEqual(self._only("vault_access").company, "globex")

    def test_requisition_with_no_approver_broadcast(self):
        requisitions.create_requisition(
            requisitions.RequisitionCreate(employee_name="Dean", employee_dept="IT", item="Monitor"),
            user={"email": ACME, "level": 1}, db=self.db)
        row = self._only("req_pending")
        self.assertEqual(row.recipient, "")
        self.assertEqual(row.company, "acme")

    def test_requisition_on_behalf_uses_the_beneficiary(self):
        requisitions.create_requisition(
            requisitions.RequisitionCreate(employee_name="Miranda", employee_email=GLOBEX,
                                           employee_dept="Ops", item="Chair"),
            user={"email": ACME, "level": 1}, db=self.db)
        self.assertEqual(self._only("req_pending").company, "globex")

    def test_investor_relations_broadcast(self):
        # Both call sites skip a fund with no manager today; the helper itself
        # still broadcasts on a blank recipient, so it has to stamp.
        investor_relations._notify(self.db, type="ir_capital_call_issued", recipient="",
                                   title="Capital Call Issued - Fund I", body="b", ref_id="call-1",
                                   actor=ACME)
        self.db.commit()
        row = self._only("ir_capital_call_issued")
        self.assertEqual(row.recipient, "")
        self.assertEqual(row.company, "acme")

    def test_unknown_actor_leaves_every_broadcast_blank(self):
        credvault._notify(self.db, type="vault_change", recipient="", title="t", body="b", actor=STRANGER)
        credvault._notify(self.db, type="vault_legacy", recipient="", title="t", body="b")
        requisitions._req_notify(self.db, type="req_pending", recipient="", title="t", body="b",
                                 actor=UNTAGGED)
        investor_relations._notify(self.db, type="ir_capital_call_issued", recipient="", title="t",
                                   body="b", actor="")
        self.db.commit()
        rows = self.db.query(models.NexusNotification).all()
        self.assertEqual(len(rows), 4)
        self.assertEqual({r.company for r in rows}, {""})


if __name__ == "__main__":
    unittest.main()
