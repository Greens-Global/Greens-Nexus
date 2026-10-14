"""Template Publish (Oct 14): editing is not releasing.

The editor autosaves an active template every 1.5 s and each save bumps its
version, so HR packets read the PUBLISHED version - a finished edit released
on purpose - never the live one. Pinned here: autosaves never publish; publish
freezes the content and the field/signer settings; a template active from
birth publishes; starters are born published; a copy stays Not Published
until someone publishes it; a template with no version row (seeded before
Publish existed) still publishes cleanly.

    python -m pytest test_doc_template_publish.py
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import documents  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
ADMIN = "ada.admin" + D
STAFF = "sam.staff" + D


def _content(text, *extra):
    return {"pages": [{"id": "p1", "json": {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": text}]}, *extra]}}]}


class PublishTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        db = database.SessionLocal()
        for m in (models.DocTemplate, models.DocTemplateVersion, models.Document, models.DocumentVersion,
                  models.DocLetterhead, models.NexusRole):
            db.query(m).delete()
        db.add(models.NexusRole(email=ADMIN, role="administrator"))
        db.commit()
        db.close()
        cache.module_grants.invalidate()
        auth._role_cache.clear()
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def _create(self, status="active", content=None):
        r = self.client.post("/documents/templates", json={
            "name": f"Offer {status}", "category": "hr", "status": status,
            "content": content or _content("Dear {{first_name}}, version one.")})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _snapshot(self, tid):
        db = database.SessionLocal()
        try:
            tpl = db.query(models.DocTemplate).filter_by(id=tid).first()
            return documents.published_snapshot(db, tpl)
        finally:
            db.close()

    def test_autosaves_never_publish(self):
        t = self._create()
        self.assertEqual(t["publishedVersion"], 1)          # born active = released
        for i in range(10):
            r = self.client.patch(f"/documents/templates/{t['id']}",
                                  json={"content": _content(f"Dear {{{{first_name}}}}, draft {i}.")})
            self.assertEqual(r.status_code, 200, r.text)
        t = r.json()
        self.assertEqual(t["version"], 11)
        self.assertEqual(t["publishedVersion"], 1)
        self.assertTrue(t["hasUnpublishedChanges"])
        content, _, version = self._snapshot(t["id"])
        self.assertEqual(version, 1)
        self.assertIn("version one", str(content))           # packets still print the released text

    def test_publish_releases_the_current_text_and_settings(self):
        t = self._create()
        self.client.patch(f"/documents/templates/{t['id']}", json={
            "content": _content("Dear {{first_name}}, version two."),
            "fieldDefs": [{"token": "salary", "label": "Salary", "type": "currency"}]})
        r = self.client.post(f"/documents/templates/{t['id']}/publish", json={"note": "Final wording"})
        self.assertEqual(r.status_code, 200, r.text)
        t = r.json()
        self.assertEqual(t["publishedVersion"], t["version"])
        self.assertFalse(t["hasUnpublishedChanges"])
        self.assertEqual(t["publishedBy"], ADMIN)
        content, meta, _ = self._snapshot(t["id"])
        self.assertIn("version two", str(content))
        self.assertEqual(meta["fieldDefs"][0]["token"], "salary")
        self.assertTrue(meta["fieldDefs"][0]["pay"])          # currency is pay
        # a later settings-only change shows as unpublished too
        self.client.patch(f"/documents/templates/{t['id']}", json={"fieldDefs": []})
        self.assertTrue(self.client.get(f"/documents/templates/{t['id']}").json()["hasUnpublishedChanges"])

    def test_a_draft_is_not_published_until_it_is_activated(self):
        t = self._create(status="draft")
        self.assertEqual(t["publishedVersion"], 0)
        self.assertEqual(self.client.post(f"/documents/templates/{t['id']}/publish", json={}).status_code, 409)
        with self.assertRaises(documents.TemplateNotPublished):
            self._snapshot(t["id"])
        t = self.client.patch(f"/documents/templates/{t['id']}", json={"status": "active"}).json()
        self.assertEqual(t["publishedVersion"], 1)

    def test_publish_adds_a_signer_for_every_signature_block(self):
        t = self._create(content=_content("Agreed.", {"type": "signatureBlock", "attrs": {"role": "employee"}}))
        self.assertEqual(t["signatureRoles"], ["employee"])
        t = self.client.post(f"/documents/templates/{t['id']}/publish", json={}).json()
        self.assertEqual([r["key"] for r in t["signerRoles"]], ["employee"])

    def test_only_template_managers_publish(self):
        t = self._create()
        os.environ["NEXUS_DEV_EMAIL"] = STAFF
        self.assertEqual(self.client.post(f"/documents/templates/{t['id']}/publish", json={}).status_code, 403)

    def test_starters_are_born_published(self):
        r = self.client.post("/documents/templates/starters")
        self.assertEqual(r.status_code, 200, r.text)
        rows = self.client.get("/documents/templates").json()
        offer = next(t for t in rows if t["name"] == "Offer Letter")
        self.assertEqual(offer["publishedVersion"], 1)
        content, _, _ = self._snapshot(offer["id"])
        self.assertIn("Offer of Employment", str(content))

    def test_a_copy_stays_not_published_until_someone_publishes_it(self):
        t = self._create()
        copy = self.client.post(f"/documents/templates/{t['id']}/duplicate").json()
        self.assertEqual(copy["publishedVersion"], 0)
        with self.assertRaises(documents.TemplateNotPublished):
            self._snapshot(copy["id"])
        copy = self.client.post(f"/documents/templates/{copy['id']}/publish", json={}).json()
        self.assertEqual(copy["publishedVersion"], 1)
        self.assertIn("version one", str(self._snapshot(copy["id"])[0]))

    def test_a_template_without_a_version_row_still_publishes(self):
        # Starters seeded before Publish existed have no DocTemplateVersion row.
        db = database.SessionLocal()
        db.add(models.DocTemplate(id="old-1", name="Old Offer", category="hr", status="active", version=3,
                                  content=_content("Old wording."), department=""))
        db.commit()
        db.close()
        t = self.client.post("/documents/templates/old-1/publish", json={}).json()
        self.assertEqual(t["publishedVersion"], 3)
        self.assertIn("Old wording", str(self._snapshot("old-1")[0]))

    def test_signing_pdf_places_fields_for_each_block(self):
        t = self._create(content=_content("Dear {{first_name}},",
                                          {"type": "signatureBlock", "attrs": {"role": "company", "label": "For Us"}},
                                          {"type": "signatureBlock", "attrs": {"role": "employee"}}))
        doc = self.client.post("/documents", json={"title": "Jane Offer", "templateId": t["id"],
                                                   "fillValues": {"first_name": "Jane"}}).json()
        r = self.client.get(f"/documents/{doc['id']}/signing-pdf")
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(out["fileName"], "Jane Offer.pdf")
        self.assertEqual({(f["role"], f["type"]) for f in out["fields"]},
                         {(role, kind) for role in ("company", "employee") for kind in ("sign", "name", "date")})
        self.assertEqual([r["key"] for r in out["roles"]], ["company", "employee"])
        self.assertTrue(all(f["required"] == (f["type"] == "sign") for f in out["fields"]))


if __name__ == "__main__":
    unittest.main()
