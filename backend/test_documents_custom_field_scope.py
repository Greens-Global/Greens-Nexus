"""Documents and More Details fields (release review, Oct 27 2026).

  * a document's subject person is the caller, someone below them in the
    reporting line, or a person inside their People scope - any other
    employee id is refused on create, on change and on export
  * an export merges only the More Details fields its audience may see: HR
    Only fields only for HR for the person (hr_custom_fields.caller_is_hr_for)
  * the variable library lists a field only if the caller could merge it: the
    caller's own company's (or shared) fields, and an HR Only field's label
    only to HR for its company

    python -m pytest -q test_documents_custom_field_scope.py
"""
import os
import tempfile
import unittest
import uuid
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from routers import documents  # noqa: E402

D = "@greensglobal.com"
FULL = "fay.full" + D          # Full People grant - HR for everyone
CONTACT = "cora.contact" + D   # company A's HR contact, no grants
VIEWER = "vic.viewer" + D      # People viewer grant - reads, is not HR
MGR = "max.mgr" + D            # Erin's manager
EMP = "erin.emp" + D           # company A
STRANGER = "sid.stranger" + D  # company A, no People access, not in Erin's line
OTHER = "omar.other" + D       # company B
CO_A, CO_B = "co-a", "co-b"


def U(email, level=1):
    return {"email": email, "level": level, "role": "employee"}


class DocScopeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except OSError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.NexusEmployee, models.NexusGroup, models.NexusGroupMember, models.NexusAccessScope,
                  models.NexusRole, models.HrEntity, models.EmployeeCustomField, models.Document,
                  models.DocumentVersion):
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.add(models.HrEntity(id=CO_A, name="Company A", hr_contact_email=CONTACT))
        self.db.add(models.HrEntity(id=CO_B, name="Company B"))
        self.ids = {}
        for i, (em, mgr, co) in enumerate(((FULL, "", CO_A), (VIEWER, "", CO_A), (MGR, "", CO_A), (EMP, MGR, CO_A),
                                           (STRANGER, "", CO_A), (OTHER, "", CO_B))):
            self.ids[em] = f"e{i}"
            self.db.add(models.NexusEmployee(id=f"e{i}", first_name=em.split(".")[0].title(), last_name="T",
                                             work_email=em, manager_email=mgr, company=co, status="active",
                                             deleted_at="",
                                             custom_fields={"secret": "Late twice", "badge": "B-77"} if em == EMP else {}))
        self.db.add(models.NexusGroup(id="g-full", name="People Full", allowed_modules="hr:full"))
        self.db.add(models.NexusGroupMember(group_id="g-full", email=FULL))
        self.db.add(models.NexusGroup(id="g-view", name="People Viewers", allowed_modules="hr:viewer"))
        self.db.add(models.NexusGroupMember(group_id="g-view", email=VIEWER))
        for fid, key, label, co, vis in (("f1", "secret", "Disciplinary Note", "", "hr_only"),
                                         ("f2", "badge", "Badge Number", "", "employee_view"),
                                         ("f3", "b_only", "Plant Code", CO_B, "employee_view"),
                                         ("f4", "b_secret", "Plant Secret", CO_B, "hr_only")):
            self.db.add(models.EmployeeCustomField(id=fid, field_key=key, label=label, company_id=co,
                                                   visibility=vis, archived=0))
        self.db.commit()
        cache.module_grants.invalidate()
        auth._role_cache.clear()

    def tearDown(self):
        self.db.close()

    def _doc(self, owner, subject):
        row = models.Document(id=str(uuid.uuid4()), title="Letter", owner_email=owner, employee_id=self.ids[subject],
                              content={}, status="draft", created_by=owner, updated_by=owner, current_version=1)
        self.db.add(row)
        self.db.commit()
        return row.id

    def refused(self, fn, code):
        with self.assertRaises(HTTPException) as e:
            fn()
        self.assertEqual(e.exception.status_code, code)

    def test_subject_must_be_in_reach_on_create_and_change(self):
        body = lambda: documents.DocumentIn(title="Letter", employeeId=self.ids[EMP])  # noqa: E731
        for who in (STRANGER, OTHER):
            self.refused(lambda: documents.create_document(body(), U(who), self.db), 404)
        for who, level in ((EMP, 1), (MGR, 3), (VIEWER, 1), (FULL, 1), (CONTACT, 1)):
            self.assertEqual(documents.create_document(body(), U(who, level), self.db)["employeeId"], self.ids[EMP])
        did = self._doc(STRANGER, STRANGER)
        self.refused(lambda: documents.update_document(did, documents.DocumentUpdate(employeeId=self.ids[EMP]),
                                                       U(STRANGER), self.db), 404)

    def test_export_merges_only_what_the_audience_may_see(self):
        seen = {}
        real = documents.resolve_merge_data

        def spy(db, **kw):
            out = real(db, **kw)
            seen["merge"] = out
            return out
        with mock.patch.object(documents, "resolve_merge_data", spy):
            for who, level, secret in ((FULL, 1, True), (CONTACT, 1, True), (MGR, 3, False), (VIEWER, 1, False),
                                       (EMP, 1, False)):
                documents._export_prep(self.db, self._doc(who, EMP), U(who, level))
                self.assertEqual("custom.secret" in seen["merge"], secret, who)
                self.assertEqual(seen["merge"].get("custom.badge"), "B-77", who)
            self.refused(lambda: documents._export_prep(self.db, self._doc(STRANGER, EMP), U(STRANGER)), 403)

    def test_variable_list_shows_only_mergeable_fields(self):
        def labels(who, level=1):
            return {v["label"] for v in documents.list_variables(U(who, level), self.db) if v["group"] == "More Details"}
        self.assertEqual(labels(STRANGER), {"Badge Number"})
        self.assertEqual(labels(VIEWER), {"Badge Number"})
        self.assertEqual(labels(OTHER), {"Badge Number", "Plant Code"})
        self.assertEqual(labels(CONTACT), {"Badge Number", "Disciplinary Note"})
        self.assertEqual(labels(FULL), {"Badge Number", "Disciplinary Note", "Plant Code", "Plant Secret"})


if __name__ == "__main__":
    unittest.main()
