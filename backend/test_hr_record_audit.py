"""Records Audit (hr_record_audit.py, Pranshu Oct 23 2026): missing details and
expired documents on everyone's record, one bell per company to HR, updated
in place and closed when the company is complete.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_hr_record_audit.py -q
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
import cache  # noqa: E402
import database  # noqa: E402
import hr_record_audit as ra  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

HR = "hr.audit.test@greensglobal.com"          # hr:editor
HEAD = "head.audit.test@greensglobal.com"      # HR department head at CO
BACKUP = "backup.audit.test@greensglobal.com"  # HR department backup at CO
CO = "co-records-audit"
PAST = (date.today() - timedelta(days=3)).isoformat()
FUTURE = (date.today() + timedelta(days=90)).isoformat()


def _us(iso):
    return f"{iso[5:7]}/{iso[8:10]}/{iso[:4]}"


class RecordsAuditTests(unittest.TestCase):
    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self.db = database.SessionLocal()
        db = self.db
        for m in (models.NexusNotification, models.HrDocument, models.HrDepartment, models.NexusGroupMember,
                  models.NexusGroup, models.HrEntity, models.NexusSetting):
            db.query(m).delete(synchronize_session=False)
        db.query(models.NexusEmployee).execution_options(include_deleted=True).delete(synchronize_session=False)
        db.add(models.HrEntity(id=CO, name="Audit Co", country="US"))
        db.add(models.HrDepartment(id="d-hr", company_id=CO, name="Human Resources", lead_email=HEAD,
                                   backup_email=BACKUP))
        for email, first in ((HEAD, "Hana"), (BACKUP, "Ben")):
            db.add(models.NexusEmployee(id=f"e-{first}", work_email=email, first_name=first, last_name="HR",
                                        company=CO, status="active", **self._complete()))
        db.add(models.NexusGroup(id="g-hr", name="People", allowed_modules="hr:editor"))
        db.add(models.NexusGroupMember(group_id="g-hr", email=HR))
        db.commit()
        for d in ("e-Hana", "e-Ben"):
            self._doc(d, "id", FUTURE)
        cache.module_grants.invalidate()
        auth._role_cache.clear()
        os.environ["NEXUS_DEV_EMAIL"] = HR

    def tearDown(self):
        self.db.close()
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    @staticmethod
    def _complete():
        return dict(manager_email="boss@greensglobal.com", start_date="2026-01-05", employment_type="full_time",
                    personal_email="me@gmail.com", personal={"emergency": {"name": "Mom", "phone": "555"}},
                    compliance={"status": "verified"})

    def _person(self, pid="e-colin", **kw):
        fields = {**self._complete(), **kw}
        self.db.add(models.NexusEmployee(id=pid, work_email=f"{pid}@greensglobal.com", first_name="Colin",
                                         last_name="Case", company=CO, status="active", **fields))
        self.db.commit()
        return self.db.query(models.NexusEmployee).filter_by(id=pid).first()

    def _doc(self, emp_id, kind, expires="", created="2026-01-01T00:00:00", name=None):
        self.db.add(models.HrDocument(id=f"doc-{emp_id}-{kind}-{created}", employee_id=emp_id, kind=kind,
                                      file_name=name or f"{kind}.pdf", storage_path="x", expires_on=expires,
                                      created_at=created))
        self.db.commit()

    def _bells(self):
        return {n.recipient: n for n in self.db.query(models.NexusNotification).filter_by(type=ra.NTYPE).all()}

    def test_a_complete_record_has_no_gaps(self):
        emp = self._person()
        self._doc(emp.id, "id", FUTURE)
        self.assertEqual(ra.gaps(self.db, emp), [])

    def test_the_colin_case_no_picture_id(self):
        emp = self._person()
        self.assertEqual(ra.gaps(self.db, emp), ["No picture ID on file"])

    def test_missing_details_are_named(self):
        emp = self._person(manager_email="", personal_email="", personal={}, compliance={})
        self._doc(emp.id, "id")
        self.assertEqual(ra.gaps(self.db, emp), ["No manager", "No personal email", "No emergency contact",
                                                 "Work authorization not verified"])

    def test_expired_documents_and_a_renewed_one(self):
        emp = self._person(compliance={"status": "verified", "expiryDate": PAST},
                           contractor={"contract_end": PAST})
        self._doc(emp.id, "id", PAST)
        self._doc(emp.id, "certificate", PAST, name="OSHA 30.pdf")
        self._doc(emp.id, "other", PAST, name="Forklift.pdf")
        self.assertEqual(ra.gaps(self.db, emp), [
            f"Picture ID expired {_us(PAST)}", f"Work authorization expired {_us(PAST)}",
            f"Certificate \"OSHA 30.pdf\" expired {_us(PAST)}", f"Document \"Forklift.pdf\" expired {_us(PAST)}",
            f"Contract ended {_us(PAST)}"])
        # A renewed ID or certificate clears the old one; an undated ID is a good ID.
        self._doc(emp.id, "id", "", created="2026-06-01T00:00:00")
        self._doc(emp.id, "certificate", FUTURE, created="2026-06-01T00:00:00")
        self.assertNotIn(f"Picture ID expired {_us(PAST)}", ra.gaps(self.db, emp))
        self.assertFalse(any("OSHA" in g for g in ra.gaps(self.db, emp)))

    def test_one_bell_per_company_to_the_hr_head_and_backup_in_place_then_closed(self):
        emp = self._person()
        self.assertGreater(ra.run_daily(), 0)
        bells = self._bells()
        self.assertEqual(set(bells), {HEAD, BACKUP})
        self.assertEqual(bells[HEAD].title, "Records Audit: Audit Co - 1 Person Needs Attention")
        self.assertIn("Colin Case: No picture ID on file", bells[HEAD].body)
        self.assertEqual(ra.run_daily(), 0)                     # nothing changed - nothing raised again
        self.assertEqual(len(self._bells()), 2)
        self._doc(emp.id, "id", FUTURE)
        ra.run_daily()
        self.db.expire_all()
        bells = self._bells()
        self.assertEqual(len(bells), 2)                         # the same rows, closed
        self.assertTrue(bells[HEAD].actioned)
        self.assertIn("All Records Complete", bells[HEAD].title)

    def test_no_hr_department_falls_back_to_the_hr_contact(self):
        self.db.query(models.HrDepartment).delete()
        self.db.query(models.HrEntity).filter_by(id=CO).update({"hr_contact_email": HR})
        self.db.commit()
        self._person()
        ra.run_daily()
        self.assertEqual(set(self._bells()), {HR})

    def test_switched_off_sends_nothing(self):
        import hr_reminder_config
        hr_reminder_config.save_config(self.db, {"recordAudit": {"enabled": False}}, {"email": HR})
        self._person()
        self.assertEqual(ra.run_daily(), 0)
        self.assertEqual(self._bells(), {})

    def test_the_screen_lists_the_same_gaps(self):
        self._person()
        r = TestClient(main.app).get("/hr/checklists/records-audit")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([(p["name"], p["gaps"]) for p in r.json()["people"]],
                         [("Colin Case", ["No picture ID on file"])])


if __name__ == "__main__":
    unittest.main()
