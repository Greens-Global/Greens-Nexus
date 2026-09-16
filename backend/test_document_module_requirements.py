"""Document Module requirements - the four gaps, pinned.

From Document_Module_Requirements.md. The module already had the library, the
wizard, typed fields and automatic population; these are what it did not have:

  * 5.1 Variable taxonomy - `principal.amount` was impossible. The resolver
    dropped any key that was not [a-z0-9_]+, so a dotted variable silently
    never populated, and the template editor rewrote the dot to an underscore.
  * 5.2 Variable library - nothing to browse. A flat list of 14 built-ins
    lived in the frontend; the company's own variables were nowhere.
  * 7  Non-editable output - `status: "final"` was a label. Nothing stopped a
    generated document being rewritten, which defeats the point of generating
    it from approved language.
  * 12 Template ownership - every template endpoint was guarded by
    get_current_user alone: any signed-in person could rewrite or delete any
    department's approved template.

    python -m unittest test_document_module_requirements
"""
import os
import tempfile
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

# Run against a THROWAWAY database, not the developer's own.
#
# These tests create templates and documents through the real API. Pointed at
# the working database - which is what happens when DATABASE_URL is unset -
# every run left ~25 templates behind, and the library reached 221 rows of
# "Note 4d77e2" and "Owned f53ed3" before anyone noticed. A test that dirties
# the thing it is testing is not a test you can run twice.
#
# Set before importing anything that touches database.py, which reads
# DATABASE_URL at import time.
_TEST_DB = os.path.join(tempfile.gettempdir(), "nexus_doc_requirements_test.db")
if os.path.exists(_TEST_DB):
    os.remove(_TEST_DB)
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB}"

from services.merge_fields import (group_label, is_auto_token, is_valid_token,  # noqa: E402
                                   resolve_merge_data, token_group)


class VariableTaxonomyTests(unittest.TestCase):
    """5.1 - dotted names, the convention the library is organized by."""

    def test_accepts_the_dotted_names_the_spec_uses(self):
        for token in ("principal.amount", "agreement.date", "place.execution",
                      "borrower.name", "lender.name"):
            self.assertTrue(is_valid_token(token), token)

    def test_still_accepts_the_undotted_built_ins(self):
        # Renaming these would break every template already in the library.
        for token in ("full_name", "company_legal", "today", "start_date"):
            self.assertTrue(is_valid_token(token), token)

    def test_rejects_a_name_that_is_not_a_name(self):
        for token in ("", "   ", "Principal.Amount", "principal amount",
                      "principal..amount", ".amount", "amount.",
                      "principal-amount", "{{principal.amount}}", "a" * 81):
            self.assertFalse(is_valid_token(token), token)

    def test_groups_by_the_part_before_the_dot(self):
        self.assertEqual(token_group("principal.amount"), "principal")
        self.assertEqual(token_group("agreement.date"), "agreement")
        self.assertEqual(token_group("full_name"), "general")

    def test_a_dotted_variable_actually_populates(self):
        # The bug this fixes: the value was accepted by the API, stored on the
        # document, and then dropped here - so the generated document kept
        # showing {{principal.amount}}.
        data = resolve_merge_data(None, overrides={
            "principal.amount": "$1,000",
            "agreement.date": "30-Sep-2026",
            "place.execution": "California",
        })
        self.assertEqual(data["principal.amount"], "$1,000")
        self.assertEqual(data["agreement.date"], "30-Sep-2026")
        self.assertEqual(data["place.execution"], "California")

    def test_a_malformed_key_is_still_dropped(self):
        data = resolve_merge_data(None, overrides={"Bad Key!": "x", "ok.one": "y"})
        self.assertNotIn("Bad Key!", data)
        self.assertEqual(data["ok.one"], "y")

    def test_the_documented_example_renders(self):
        """Requirement 7's worked example, end to end."""
        template = ("The borrower agrees to repay {{principal.amount}} "
                    "on {{agreement.date}} at {{place.execution}}.")
        data = resolve_merge_data(None, overrides={
            "principal.amount": "$1,000", "agreement.date": "30-Sep-2026",
            "place.execution": "California"})
        out = template
        for token, value in data.items():
            out = out.replace("{{%s}}" % token, value)
        self.assertEqual(
            out, "The borrower agrees to repay $1,000 on 30-Sep-2026 at California.")


NDA_VARIABLES = [
    "agreement.effective_date", "agreement.purpose", "agreement.confidentiality_period",
    "agreement.governing_law", "agreement.jurisdiction",
    "party_a.legal_name", "party_a.entity_type", "party_a.jurisdiction", "party_a.address",
    "party_a.notice_contact_name", "party_a.notice_address", "party_a.notice_email",
    "party_a.signatory_name", "party_a.signatory_title", "party_a.signature_date",
    "party_b.legal_name", "party_b.entity_type", "party_b.jurisdiction", "party_b.address",
    "party_b.notice_contact_name", "party_b.notice_address", "party_b.notice_email",
    "party_b.signatory_name", "party_b.signatory_title", "party_b.signature_date",
    "template.version", "template.last_updated", "template.owner_department",
]


class RealNdaTaxonomyTests(unittest.TestCase):
    """The Mutual NDA Sagar supplied - the taxonomy as it will really be used.

    28 variables across four groups. Two things it exposed that a synthetic
    fixture did not: `party_a` read as "Party_a" in the library, and the three
    `template.*` variables were being asked of the USER even though the system
    knows every one of them.
    """

    def test_every_variable_in_the_real_template_is_a_legal_name(self):
        for token in NDA_VARIABLES:
            self.assertTrue(is_valid_token(token), token)

    def test_they_fall_into_the_groups_the_template_intends(self):
        groups = {token_group(t) for t in NDA_VARIABLES}
        self.assertEqual(groups, {"agreement", "party_a", "party_b", "template"})

    def test_a_group_reads_as_a_person_would_write_it(self):
        self.assertEqual(group_label("party_a"), "Party A")
        self.assertEqual(group_label("party_b"), "Party B")
        self.assertEqual(group_label("agreement"), "Agreement")

    def test_the_two_parties_never_collide(self):
        # The whole reason for the taxonomy: party_a.legal_name and
        # party_b.legal_name are different variables, not one shared "name".
        data = resolve_merge_data(None, overrides={
            "party_a.legal_name": "Greens Global", "party_b.legal_name": "Acme Corp"})
        self.assertEqual(data["party_a.legal_name"], "Greens Global")
        self.assertEqual(data["party_b.legal_name"], "Acme Corp")

    def test_template_metadata_is_the_systems_job_not_the_users(self):
        for token in ("template.version", "template.last_updated",
                      "template.owner_department", "template.name"):
            self.assertTrue(is_auto_token(token), token)
        for token in ("agreement.effective_date", "party_a.legal_name", "full_name"):
            self.assertFalse(is_auto_token(token), token)

    def test_template_metadata_resolves_from_the_template_row(self):
        class FakeTemplate:
            name, version = "Mutual Non-Disclosure Agreement", 3
            updated_at, created_at, department = "2026-09-17T09:00:00+00:00", "", "Legal"
        data = resolve_merge_data(None, template=FakeTemplate())
        self.assertEqual(data["template.name"], "Mutual Non-Disclosure Agreement")
        self.assertEqual(data["template.version"], "3")
        self.assertEqual(data["template.last_updated"], "2026-09-17")
        self.assertEqual(data["template.owner_department"], "Legal")


class _ApiTests(unittest.TestCase):
    """Shared TestClient setup - the app boots against the local SQLite."""

    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        # The schema is created by the app's lifespan, which TestClient does
        # not run unless it is used as a context manager - so build it here
        # against the throwaway database.
        import models  # noqa: F401  (registers every table on the metadata)
        from database import Base, engine, SessionLocal
        Base.metadata.create_all(engine)
        # A throwaway database has no roles, so the dev user would be a plain
        # employee and every template write would (correctly) 403. Seed the
        # caller as an administrator - these tests are about the Document
        # module's behaviour, not about who is allowed to reach it; the
        # permission rules have their own tests.
        from main import app          # also loads backend/.env, which sets NEXUS_DEV_EMAIL
        import auth
        email = os.environ.get("NEXUS_DEV_EMAIL", "dev@localhost").lower()
        with SessionLocal() as db:
            if not db.query(models.NexusRole).filter(models.NexusRole.email == email).first():
                db.add(models.NexusRole(email=email, role="administrator", assigned_by="test"))
            # One signing template to migrate, so the migration test has
            # something real to move rather than depending on whatever happens
            # to be in the developer's own database.
            if not db.query(models.HrSignTemplate).first():
                db.add(models.HrSignTemplate(
                    id="test-sign-tpl", name="Legacy Signing Template", kind="nda",
                    body=["CONFIDENTIALITY", "Signed by {{full_name}} on {{today}}.",
                          "[[sign:employee]]", "[[date:employee]]"],
                    roles=[{"key": "employee", "label": "Recipient", "order": 1}],
                    status="active"))
            db.commit()
        auth._role_cache.clear()
        cls.client = TestClient(app)


class DottedVariableRoundTripTests(_ApiTests):
    """The taxonomy has to survive being SAVED, not just resolved.

    Three separate places enforced the old undotted rule - the resolver, the
    field-definition cleaner, and the merge-override cleaner. Fixing the first
    two still left `principal.amount` silently dropped on its way into the
    database: the PATCH returned 200 and stored {}.
    """

    def test_a_dotted_value_survives_a_save(self):
        did = self.client.post("/documents", json={"title": f"Note {uuid.uuid4().hex[:8]}"}).json()["id"]
        r = self.client.patch(f"/documents/{did}", json={"mergeOverrides": {
            "principal.amount": "$1,000", "agreement.date": "30-Sep-2026",
            "place.execution": "California", "borrower.name": "A. Borrower"}})
        self.assertEqual(r.status_code, 200, r.text)
        stored = self.client.get(f"/documents/{did}").json()["mergeOverrides"]
        self.assertEqual(stored["principal.amount"], "$1,000")
        self.assertEqual(stored["agreement.date"], "30-Sep-2026")
        self.assertEqual(stored["place.execution"], "California")
        self.assertEqual(stored["borrower.name"], "A. Borrower")

    def test_a_malformed_key_is_still_not_stored(self):
        did = self.client.post("/documents", json={"title": f"Note {uuid.uuid4().hex[:8]}"}).json()["id"]
        self.client.patch(f"/documents/{did}", json={"mergeOverrides": {"Bad Key!": "x", "fine.one": "y"}})
        stored = self.client.get(f"/documents/{did}").json()["mergeOverrides"]
        self.assertNotIn("Bad Key!", stored)
        self.assertEqual(stored["fine.one"], "y")

    def test_a_dotted_field_definition_survives_on_a_template(self):
        r = self.client.post("/documents/templates", json={
            "name": f"Promissory Note {uuid.uuid4().hex[:6]}",
            "fieldDefs": [{"token": "principal.amount", "label": "Principal Amount", "type": "currency"},
                          {"token": "agreement.date", "label": "Date", "type": "date"}]})
        self.assertEqual(r.status_code, 200, r.text)
        tokens = [fd["token"] for fd in r.json()["fieldDefs"]]
        self.assertIn("principal.amount", tokens)
        self.assertIn("agreement.date", tokens)


class TemplateLifecycleTests(_ApiTests):
    """3 / 20 - Draft -> Active -> Archived, and only Active generates.

    "Company-approved" only means something if a template still being written
    cannot be generated from. Status was previously active|archived with NO
    validation at all: any string became the status.
    """

    def _tpl(self, **kw):
        r = self.client.post("/documents/templates",
                             json={"name": f"T {uuid.uuid4().hex[:6]}", **kw})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_a_template_can_be_created_as_a_draft(self):
        self.assertEqual(self._tpl(status="draft")["status"], "draft")

    def test_a_draft_cannot_be_generated_from(self):
        tpl = self._tpl(status="draft")
        r = self.client.post("/documents", json={"title": "From draft", "templateId": tpl["id"]})
        self.assertEqual(r.status_code, 409)
        self.assertIn("draft", r.json()["detail"])
        self.assertIn(tpl["name"], r.json()["detail"])   # names the template, not an id

    def test_an_archived_template_cannot_be_generated_from(self):
        tpl = self._tpl()
        self.client.patch(f"/documents/templates/{tpl['id']}", json={"status": "archived"})
        r = self.client.post("/documents", json={"title": "From archived", "templateId": tpl["id"]})
        self.assertEqual(r.status_code, 409)
        self.assertIn("archived", r.json()["detail"])

    def test_activating_the_draft_makes_it_usable(self):
        tpl = self._tpl(status="draft")
        self.client.patch(f"/documents/templates/{tpl['id']}", json={"status": "active"})
        r = self.client.post("/documents", json={"title": "From active", "templateId": tpl["id"]})
        self.assertEqual(r.status_code, 200, r.text)

    def test_a_missing_template_says_so_plainly(self):
        # Requirement 20 - a user-friendly error, not a stack trace.
        r = self.client.post("/documents", json={"title": "x", "templateId": "does-not-exist"})
        self.assertEqual(r.status_code, 404)
        self.assertIn("template", r.json()["detail"].lower())

    def test_a_nonsense_status_is_refused(self):
        tpl = self._tpl()
        r = self.client.patch(f"/documents/templates/{tpl['id']}", json={"status": "aproved"})
        self.assertEqual(r.status_code, 400)

    def test_a_template_declares_what_it_produces(self):
        # Requirement 3 metadata: document or email.
        self.assertEqual(self._tpl()["docType"], "document")
        self.assertEqual(self._tpl(docType="email")["docType"], "email")
        r = self.client.post("/documents/templates",
                             json={"name": "bad type", "docType": "carrier-pigeon"})
        self.assertEqual(r.status_code, 400)


class TemplateVersionLinkTests(_ApiTests):
    """17 / Scenario B - a document remembers the version it came from."""

    def test_a_generated_document_records_the_template_version(self):
        tpl = self.client.post("/documents/templates", json={"name": f"V {uuid.uuid4().hex[:6]}"}).json()
        doc = self.client.post("/documents", json={"title": "v1 doc", "templateId": tpl["id"]}).json()
        self.assertEqual(doc["templateVersion"], tpl["version"])

    def test_editing_the_template_does_not_touch_the_old_document(self):
        tpl = self.client.post("/documents/templates", json={"name": f"V {uuid.uuid4().hex[:6]}"}).json()
        first = self.client.post("/documents", json={"title": "old", "templateId": tpl["id"]}).json()
        bumped = self.client.patch(f"/documents/templates/{tpl['id']}", json={
            "content": {"pages": [{"id": "p1", "json": {"type": "doc", "content": []}}]}}).json()
        self.assertGreater(bumped["version"], tpl["version"])
        second = self.client.post("/documents", json={"title": "new", "templateId": tpl["id"]}).json()
        # Old document unchanged, new one on the new version.
        self.assertEqual(self.client.get(f"/documents/{first['id']}").json()["templateVersion"], tpl["version"])
        self.assertEqual(second["templateVersion"], bumped["version"])

    def test_a_document_with_no_template_records_no_version(self):
        doc = self.client.post("/documents", json={"title": f"Blank {uuid.uuid4().hex[:6]}"}).json()
        self.assertEqual(doc["templateVersion"], 0)


class ValueValidationTests(_ApiTests):
    """19 - validate values before generating, not after someone signs."""

    def _tpl_with(self, ftype, token="x.value"):
        return self.client.post("/documents/templates", json={
            "name": f"V {uuid.uuid4().hex[:6]}",
            "fieldDefs": [{"token": token, "label": "Value", "type": ftype}]}).json()

    def test_an_invalid_email_is_refused(self):
        tpl = self._tpl_with("email", "party_a.notice_email")
        r = self.client.post("/documents", json={
            "title": "bad email", "templateId": tpl["id"],
            "fillValues": {"party_a.notice_email": "not-an-email"}})
        self.assertEqual(r.status_code, 422)
        self.assertIn("email", r.json()["detail"].lower())

    def test_a_valid_email_goes_through(self):
        tpl = self._tpl_with("email", "party_a.notice_email")
        r = self.client.post("/documents", json={
            "title": "good email", "templateId": tpl["id"],
            "fillValues": {"party_a.notice_email": "legal@greensglobal.com"}})
        self.assertEqual(r.status_code, 200, r.text)

    def test_a_non_numeric_amount_is_refused(self):
        tpl = self._tpl_with("currency", "principal.amount")
        r = self.client.post("/documents", json={
            "title": "bad amount", "templateId": tpl["id"],
            "fillValues": {"principal.amount": "quite a lot"}})
        self.assertEqual(r.status_code, 422)

    def test_a_formatted_amount_is_accepted(self):
        tpl = self._tpl_with("currency", "principal.amount")
        r = self.client.post("/documents", json={
            "title": "good amount", "templateId": tpl["id"],
            "fillValues": {"principal.amount": "$1,000.00"}})
        self.assertEqual(r.status_code, 200, r.text)

    def test_an_impossible_date_is_refused(self):
        tpl = self._tpl_with("date", "agreement.effective_date")
        r = self.client.post("/documents", json={
            "title": "bad date", "templateId": tpl["id"],
            "fillValues": {"agreement.effective_date": "32-13-2026"}})
        self.assertEqual(r.status_code, 422)

    def test_the_new_types_are_accepted_on_a_template(self):
        tpl = self.client.post("/documents/templates", json={
            "name": f"Types {uuid.uuid4().hex[:6]}",
            "fieldDefs": [
                {"token": "party_a.notice_email", "label": "Email", "type": "email",
                 "description": "Where formal notices are sent"},
                {"token": "party_a.address", "label": "Address", "type": "address"},
                {"token": "party_a.signatory_name", "label": "Signatory", "type": "person"}]}).json()
        by = {f["token"]: f for f in tpl["fieldDefs"]}
        self.assertEqual(by["party_a.notice_email"]["type"], "email")
        self.assertEqual(by["party_a.address"]["type"], "address")
        self.assertEqual(by["party_a.signatory_name"]["type"], "person")
        # Requirement 5's variable metadata.
        self.assertEqual(by["party_a.notice_email"]["description"], "Where formal notices are sent")
        self.assertEqual(by["party_a.notice_email"]["category"], "party_a")


class VariableLibraryTests(_ApiTests):
    """5.2 - browse the variables, rather than remembering them."""

    def test_lists_the_built_in_variables_with_labels_and_groups(self):
        r = self.client.get("/documents/variables")
        self.assertEqual(r.status_code, 200)
        by_token = {v["token"]: v for v in r.json()}
        self.assertIn("full_name", by_token)
        self.assertEqual(by_token["full_name"]["label"], "Full name")
        self.assertEqual(by_token["full_name"]["group"], "Person")
        self.assertEqual(by_token["company_legal"]["group"], "Company")
        self.assertEqual(by_token["today"]["group"], "Document")

    def test_every_entry_carries_what_the_picker_needs(self):
        for v in self.client.get("/documents/variables").json():
            self.assertTrue(v["token"])
            self.assertTrue(v["label"], v["token"])
            self.assertIn(v["source"], ("builtin", "template"))
            self.assertIsInstance(v["usedBy"], list)

    def test_built_ins_come_first(self):
        sources = [v["source"] for v in self.client.get("/documents/variables").json()]
        if "template" in sources:
            self.assertLess(sources.index("builtin"), sources.index("template"))


class GeneratedOutputIsFinalTests(_ApiTests):
    """7 - "The generated output should be non-editable."

    The lock existing is not the same as the requirement being met: a
    generated document used to be born a DRAFT, so the guarantee held only
    when somebody remembered to apply it. Generation now produces final
    output; a document authored from scratch is not generated output and is
    still a draft.
    """

    def _template(self, **kw):
        body = {"name": f"Note {uuid.uuid4().hex[:6]}", **kw}
        r = self.client.post("/documents/templates", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_a_document_generated_from_a_template_is_final(self):
        tpl = self._template(fieldDefs=[
            {"token": "principal.amount", "label": "Principal Amount", "type": "text", "required": True}])
        r = self.client.post("/documents", json={
            "title": "Generated", "templateId": tpl["id"],
            "fillValues": {"principal.amount": "$1,000"}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "final")

    def test_it_cannot_then_be_edited(self):
        tpl = self._template()
        did = self.client.post("/documents", json={"title": "Generated", "templateId": tpl["id"]}).json()["id"]
        r = self.client.patch(f"/documents/{did}", json={"mergeOverrides": {"a.b": "x"}})
        self.assertEqual(r.status_code, 409)

    def test_the_history_says_it_was_generated(self):
        tpl = self._template()
        did = self.client.post("/documents", json={"title": "Generated", "templateId": tpl["id"]}).json()["id"]
        notes = [v.get("note", "") for v in self.client.get(f"/documents/{did}/versions").json()]
        self.assertIn("Generated from template", notes)

    def test_a_document_written_from_scratch_is_still_a_draft(self):
        # Authoring is not generating - locking a blank document someone just
        # created would make the module unusable for anything but templates.
        r = self.client.post("/documents", json={"title": f"Blank {uuid.uuid4().hex[:6]}"})
        self.assertEqual(r.json()["status"], "draft")

    def test_unlock_is_the_way_to_amend_generated_output(self):
        tpl = self._template()
        did = self.client.post("/documents", json={"title": "Generated", "templateId": tpl["id"]}).json()["id"]
        self.assertEqual(self.client.post(f"/documents/{did}/unlock").json()["status"], "draft")
        self.assertEqual(self.client.patch(f"/documents/{did}", json={"title": "Amended"}).status_code, 200)


class TemplateOwnershipTests(_ApiTests):
    """12 - a template's owning department is maintainable, not write-once."""

    def test_the_owning_department_can_be_changed_after_creation(self):
        r = self.client.post("/documents/templates", json={
            "name": f"Owned {uuid.uuid4().hex[:6]}", "department": "Legal"})
        tid = r.json()["id"]
        self.assertEqual(r.json()["department"], "Legal")
        moved = self.client.patch(f"/documents/templates/{tid}", json={"department": "Finance"})
        self.assertEqual(moved.status_code, 200, moved.text)
        self.assertEqual(moved.json()["department"], "Finance")

    def test_it_can_be_handed_back_to_the_company(self):
        tid = self.client.post("/documents/templates", json={
            "name": f"Owned {uuid.uuid4().hex[:6]}", "department": "Legal"}).json()["id"]
        r = self.client.patch(f"/documents/templates/{tid}", json={"department": ""})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["department"], "")

    def test_the_department_is_reported_on_every_template(self):
        # The library screen shows ownership per template; it can only do that
        # if the list endpoint carries it.
        for t in self.client.get("/documents/templates").json():
            self.assertIn("department", t)


class NonEditableOutputTests(_ApiTests):
    """7 - a document that is final refuses edits, whatever made it final."""

    def _make_doc(self):
        r = self.client.post("/documents", json={"title": f"Req test {uuid.uuid4().hex[:8]}"})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["id"]

    def test_a_final_document_refuses_a_content_edit(self):
        did = self._make_doc()
        self.client.patch(f"/documents/{did}", json={"status": "final"})
        r = self.client.patch(f"/documents/{did}", json={
            "content": {"pages": [{"id": "p1", "json": {"type": "doc", "content": []}}]}})
        self.assertEqual(r.status_code, 409)
        self.assertIn("final", r.json()["detail"].lower())

    def test_a_final_document_refuses_new_merge_values(self):
        # Changing the values IS changing what the document says.
        did = self._make_doc()
        self.client.patch(f"/documents/{did}", json={"status": "final"})
        r = self.client.patch(f"/documents/{did}", json={"mergeOverrides": {"principal.amount": "$2"}})
        self.assertEqual(r.status_code, 409)

    def test_filing_a_final_document_is_still_allowed(self):
        # Renaming, tagging, moving and sending must keep working - locking the
        # words is not the same as freezing the document in place.
        did = self._make_doc()
        self.client.patch(f"/documents/{did}", json={"status": "final"})
        r = self.client.patch(f"/documents/{did}", json={"title": "Renamed", "tags": ["legal"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["title"], "Renamed")

    def test_unlock_returns_it_to_draft_and_leaves_a_record(self):
        did = self._make_doc()
        self.client.patch(f"/documents/{did}", json={"status": "final"})
        r = self.client.post(f"/documents/{did}/unlock")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "draft")
        notes = [v.get("note", "") for v in self.client.get(f"/documents/{did}/versions").json()]
        self.assertTrue(any("Unlocked" in n for n in notes), notes)

    def test_editing_works_again_after_unlock(self):
        did = self._make_doc()
        self.client.patch(f"/documents/{did}", json={"status": "final"})
        self.client.post(f"/documents/{did}/unlock")
        r = self.client.patch(f"/documents/{did}", json={
            "content": {"pages": [{"id": "p1", "json": {"type": "doc", "content": []}}]}})
        self.assertEqual(r.status_code, 200, r.text)

    def test_unlocking_a_draft_is_refused(self):
        r = self.client.post(f"/documents/{self._make_doc()}/unlock")
        self.assertEqual(r.status_code, 409)


if __name__ == "__main__":
    unittest.main()


class SignerRolesAndMigrationTests(_ApiTests):
    """One template library (requirements 10 / 25).

    Two systems existed because hr_sign_templates carried signer roles and the
    Documents library did not. It does now, so the separate signing-template
    manager has nothing left that only it can hold.
    """

    def test_a_template_remembers_who_normally_signs(self):
        r = self.client.post("/documents/templates", json={
            "name": f"Signed {uuid.uuid4().hex[:6]}",
            "signerRoles": [{"key": "employee", "label": "Employee", "order": 2},
                            {"key": "company", "label": "Company representative", "order": 1}]})
        self.assertEqual(r.status_code, 200, r.text)
        roles = r.json()["signerRoles"]
        # Stored in signing ORDER, not the order they were typed.
        self.assertEqual([x["key"] for x in roles], ["company", "employee"])

    def test_it_refuses_a_malformed_role(self):
        r = self.client.post("/documents/templates", json={
            "name": f"Signed {uuid.uuid4().hex[:6]}",
            "signerRoles": [{"key": "Bad Key!"}, {"key": ""}, {"key": "employee"},
                            {"key": "employee", "label": "duplicate"}]})
        self.assertEqual([x["key"] for x in r.json()["signerRoles"]], ["employee"])

    def test_the_roles_survive_an_edit_and_a_duplicate(self):
        tid = self.client.post("/documents/templates", json={
            "name": f"Signed {uuid.uuid4().hex[:6]}",
            "signerRoles": [{"key": "employee", "label": "Employee", "order": 1}]}).json()["id"]
        copy_ = self.client.post(f"/documents/templates/{tid}/duplicate").json()
        self.assertEqual([x["key"] for x in copy_["signerRoles"]], ["employee"])
        edited = self.client.patch(f"/documents/templates/{tid}", json={
            "signerRoles": [{"key": "company", "label": "Company", "order": 1}]}).json()
        self.assertEqual([x["key"] for x in edited["signerRoles"]], ["company"])

    def test_migration_is_idempotent(self):
        first = self.client.post("/documents/templates/migrate-sign-templates")
        self.assertEqual(first.status_code, 200, first.text)
        second = self.client.post("/documents/templates/migrate-sign-templates").json()
        # Everything the first run moved is skipped by the second.
        self.assertEqual(second["migrated"], [])

    def test_a_migrated_template_arrives_as_a_draft_with_its_signers(self):
        self.client.post("/documents/templates/migrate-sign-templates")
        migrated = [t for t in self.client.get("/documents/templates", params={"status": "draft"}).json()
                    if "migrated-from-nexus-sign" in (t.get("tags") or [])]
        self.assertTrue(migrated, "expected at least one migrated template")
        for t in migrated:
            # Draft: migrated language is reviewed before anyone generates from it.
            self.assertEqual(t["status"], "draft")
            self.assertTrue(t["signerRoles"], t["name"])


class SignBodyConversionTests(unittest.TestCase):
    """The body of an e-sign template is a list of plain strings."""

    def setUp(self):
        from routers.documents import _sign_body_to_content
        self.convert = _sign_body_to_content

    def _text(self, content):
        blocks = content["pages"][0]["json"]["content"]
        return " ".join(c.get("text", "") for b in blocks for c in (b.get("content") or []))

    def test_field_markers_are_dropped_not_carried_across_as_text(self):
        # A regression with teeth: a stray control character in the pattern made
        # this silently pass everything through, and "[[sign:employee]]" ended
        # up as literal text in a legal template.
        content, _ = self.convert(["Dear {{first_name}},", "[[sign:employee]]",
                                   "[[date:employee]]",
                                   "[[check:employee:I have read and understood this agreement]]"])
        self.assertNotIn("[[", self._text(content))
        self.assertEqual(len(content["pages"][0]["json"]["content"]), 1)

    def test_tokens_become_real_merge_fields(self):
        content, defs = self.convert(["Dear {{first_name}} at {{company}}."])
        kinds = [c["type"] for c in content["pages"][0]["json"]["content"][0]["content"]]
        self.assertEqual(kinds, ["text", "mergeField", "text", "mergeField", "text"])
        self.assertEqual({d["token"] for d in defs}, {"first_name", "company"})

    def test_a_date_token_is_typed_as_a_date(self):
        _, defs = self.convert(["Signed on {{today}}"])
        self.assertEqual(defs[0]["type"], "date")

    def test_an_empty_body_still_produces_a_usable_document(self):
        content, defs = self.convert([])
        self.assertEqual(content["pages"][0]["json"]["content"], [{"type": "paragraph"}])
        self.assertEqual(defs, [])
