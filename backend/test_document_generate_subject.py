"""
Generating a document straight from a template has to carry the SUBJECT and the
COMPANY (Sagar, Sep 21 2026: "It's not showing the variables, {{variable}}").

Nexus Sign's "start from a template" posts /documents with just the template id,
so the new document had no employee_id and no entity_id - nothing for
resolve_merge_data to fill {{full_name}} / {{job_title}} / {{company_address}}
from - and the generated PDF kept the raw tokens. DocumentIn now takes
employeeId/entityId, the same two ids DocumentUpdate always had.

Uses a throwaway sqlite file. No network.

    python -m unittest test_document_generate_subject
"""
import os
import tempfile
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
_TEST_DB = os.path.join(tempfile.gettempdir(), "nexus_doc_subject_test.db")
if os.path.exists(_TEST_DB):
    os.remove(_TEST_DB)
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB}"

import models                                            # noqa: E402
from database import Base, SessionLocal, engine          # noqa: E402
from services.merge_fields import resolve_merge_data     # noqa: E402

BODY = {"type": "doc", "content": [{"type": "paragraph", "content": [
    {"type": "text", "text": "Dear {{full_name}}, your role is {{job_title}} at {{company_address}}."}]}]}


class GenerateWithSubjectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        Base.metadata.create_all(engine)
        from main import app
        import auth
        email = os.environ.get("NEXUS_DEV_EMAIL", "dev@localhost").lower()
        with SessionLocal() as db:
            if not db.query(models.NexusRole).filter(models.NexusRole.email == email).first():
                db.add(models.NexusRole(email=email, role="administrator", assigned_by="test"))
            cls.emp_id = str(uuid.uuid4())
            db.add(models.NexusEmployee(id=cls.emp_id, first_name="Asha", last_name="Rao",
                                        work_email="asha.rao@greensglobal.com", job_title="Site Engineer",
                                        department="Construction", start_date="2026-10-01"))
            cls.entity_id = str(uuid.uuid4())
            db.add(models.HrEntity(id=cls.entity_id, name="Greens Global",
                                   legal_name="Greens Global LLC",
                                   registered_address="1 Greens Way, Bakersfield, CA"))
            db.commit()
        auth._role_cache.clear()
        cls.client = TestClient(app)

    def _template(self):
        r = self.client.post("/documents/templates",
                             json={"name": f"Joining Letter {uuid.uuid4().hex[:6]}", "content": {"body": BODY}})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_the_document_is_born_with_its_subject_and_company(self):
        tpl = self._template()
        r = self.client.post("/documents", json={"title": "Joining Letter", "templateId": tpl["id"],
                                                 "employeeId": self.emp_id, "entityId": self.entity_id})
        self.assertEqual(r.status_code, 200, r.text)
        doc = r.json()
        self.assertEqual(doc["employeeId"], self.emp_id)
        self.assertEqual(doc["entityId"], self.entity_id)

    def test_those_ids_are_what_fills_the_variables(self):
        with SessionLocal() as db:
            merge = resolve_merge_data(db, employee_id=self.emp_id, entity_id=self.entity_id)
        self.assertEqual(merge["full_name"], "Asha Rao")
        self.assertEqual(merge["job_title"], "Site Engineer")
        self.assertEqual(merge["company_address"], "1 Greens Way, Bakersfield, CA")

    def test_the_generated_export_shows_values_not_tokens(self):
        tpl = self._template()
        doc = self.client.post("/documents", json={"title": "Filled", "templateId": tpl["id"],
                                                   "employeeId": self.emp_id, "entityId": self.entity_id}).json()
        text = self._export_text(doc["id"])
        self.assertIn("Dear Asha Rao", text)
        self.assertIn("Site Engineer", text)
        self.assertNotIn("{{", text)

    def test_the_api_hands_the_template_its_variable_list(self):
        """Nexus Sign reads `tokens` to build the fill form when a template is
        picked - so it has to come back with the template."""
        tpl = self._template()
        self.assertEqual(tpl["tokens"], ["company_address", "full_name", "job_title"])
        listed = self.client.get("/documents/templates").json()
        mine = next(t for t in listed if t["id"] == tpl["id"])
        self.assertEqual(mine["tokens"], ["company_address", "full_name", "job_title"])

    def test_without_a_subject_the_tokens_are_left_alone(self):
        """The old behavior, kept honest: no subject means nothing to fill -
        the document still generates, it just shows the raw tokens."""
        tpl = self._template()
        doc = self.client.post("/documents", json={"title": "Bare", "templateId": tpl["id"]}).json()
        self.assertEqual(doc["employeeId"], "")
        self.assertIn("{{full_name}}", self._export_text(doc["id"]))

    def _export_text(self, did: str) -> str:
        """The resolved body, as the exporters see it (no PDF rendering)."""
        from routers.documents import _export_prep
        with SessionLocal() as db:
            _row, _h, pages, _f, _lh, _ps = _export_prep(
                db, did, {"email": os.environ.get("NEXUS_DEV_EMAIL", "dev@localhost").lower(),
                          "role": "administrator", "level": 4})
        return " ".join(_block_text(b) for page in pages for b in page)


def _block_text(block) -> str:
    if isinstance(block, dict):
        return " ".join(_block_text(v) for v in block.values())
    if isinstance(block, list):
        return " ".join(_block_text(v) for v in block)
    return str(block)


class TemplateTokenListTests(unittest.TestCase):
    """What Nexus Sign asks for when a template is picked: every {{variable}}
    the template really uses, however it was written."""

    def _tokens(self, content):
        from routers.documents import _template_tokens

        class _T:
            pass
        t = _T()
        t.content = content
        return _template_tokens(t)

    def test_it_finds_plain_text_and_merge_field_nodes(self):
        content = {"body": {"type": "doc", "content": [
            {"type": "paragraph", "content": [
                {"type": "text", "text": "Dear {{full_name}} of {{ company_legal }},"},
                {"type": "mergeField", "attrs": {"token": "job_title"}}]}]}}
        self.assertEqual(self._tokens(content), ["company_legal", "full_name", "job_title"])

    def test_it_looks_in_every_part_of_the_template(self):
        content = {"header": {"type": "doc", "content": [{"type": "paragraph", "content": [
                       {"type": "text", "text": "{{company}}"}]}]},
                   "pages": [{"json": {"type": "doc", "content": [{"type": "paragraph", "content": [
                       {"type": "text", "text": "{{start_date}}"}]}]}}]}
        self.assertEqual(self._tokens(content), ["company", "start_date"])

    def test_the_self_filling_ones_are_never_asked_for(self):
        content = {"body": {"type": "doc", "content": [{"type": "paragraph", "content": [
            {"type": "text", "text": "{{today}} {{template.version}} {{full_name}}"}]}]}}
        self.assertEqual(self._tokens(content), ["full_name"])

    def test_a_template_with_no_variables_asks_for_nothing(self):
        self.assertEqual(self._tokens({"body": {"type": "doc", "content": []}}), [])
        self.assertEqual(self._tokens(None), [])


class PlainTextTokenTests(unittest.TestCase):
    """A {{token}} typed as ordinary text (hand-written, pasted, or imported
    from Word) has to fill too - only the editor's mergeField NODES used to."""

    def _runs(self, text, merge):
        from services.doc_export import tiptap_to_blocks
        doc = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}
        return "".join(r["text"] for r in tiptap_to_blocks(doc, merge)[0]["runs"])

    def test_it_fills_from_the_merge_data(self):
        self.assertEqual(self._runs("Dear {{full_name}},", {"full_name": "Asha Rao"}), "Dear Asha Rao,")

    def test_dotted_and_spaced_tokens_fill_too(self):
        self.assertEqual(self._runs("{{ principal.amount }}", {"principal.amount": "$1,000"}), "$1,000")

    def test_an_unknown_token_is_left_exactly_as_written(self):
        self.assertEqual(self._runs("Hi {{nobody}}", {"full_name": "Asha"}), "Hi {{nobody}}")

    def test_text_without_tokens_is_untouched(self):
        self.assertEqual(self._runs("Braces { like } this stay", {}), "Braces { like } this stay")

    def test_the_merge_field_node_path_still_works(self):
        from services.doc_export import tiptap_to_blocks
        doc = {"type": "doc", "content": [{"type": "paragraph", "content": [
            {"type": "mergeField", "attrs": {"token": "job_title"}}]}]}
        blocks = tiptap_to_blocks(doc, {"job_title": "Site Engineer"})
        self.assertEqual(blocks[0]["runs"][0]["text"], "Site Engineer")


if __name__ == "__main__":
    unittest.main()
