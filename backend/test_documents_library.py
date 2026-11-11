"""
The Documents library list (Neil, 10/31/2026): GET /documents/library is every
document and envelope the caller may see, one row each, and no new access rule -
someone who could not see an envelope's people still cannot; a document with an
envelope is one row, not two; another company's rows stay behind the wall.

One Publish: a document is made from the published wording, never an edit in
progress; publishing a draft is the only step; a template live since before
Publish was one step is released as it stands.

    python -m pytest test_documents_library.py
"""
import os
import tempfile
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import auth              # noqa: E402
import database          # noqa: E402
import models            # noqa: E402
from routers import documents  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
import main              # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

ADMIN = "library.admin@greensglobal.com"
STAFF = "library.staff@greensglobal.com"
OTHER = "library.other@greensglobal.com"


def _content(text):
    return {"pages": [{"id": "p1", "json": {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": text}]}]}}]}


class _Base(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        db = database.SessionLocal()
        for m in (models.Document, models.DocumentVersion, models.DocTemplate, models.DocTemplateVersion,
                  models.HrSignRequest, models.HrSignParty, models.NexusEmployee, models.NexusRole, models.HrEntity):
            db.query(m).delete()
        db.add(models.NexusRole(email=ADMIN, role="owner"))   # Super Administrator (Neil, 11/02/2026)
        db.add(models.HrEntity(id="ent-1", name="Greens Global"))
        db.add(models.NexusEmployee(id="emp-1", first_name="Jordan", last_name="Lee", work_email=OTHER))
        db.commit()
        db.close()
        auth._role_cache.clear()
        self.as_user(ADMIN)

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def as_user(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth._role_cache.clear()

    def _envelope(self, title="Vendor Agreement", status="pending", created_by=ADMIN, **kw):
        rid = f"req-{uuid.uuid4()}"
        db = database.SessionLocal()
        db.add(models.HrSignRequest(id=rid, title=title, status=status, routing="sequential", current_order=1,
                                    source="pdf", created_by=created_by, created_at="2026-10-20T09:00:00+00:00",
                                    **kw))
        db.commit()
        db.close()
        return rid

    def _party(self, rid, email, name, ordinal=1, status="notified", role="signer"):
        pid = f"p-{uuid.uuid4()}"
        db = database.SessionLocal()
        db.add(models.HrSignParty(id=pid, request_id=rid, name=name, email=email, ordinal=ordinal, status=status,
                                  party_role=role, kind="internal"))
        db.commit()
        db.close()
        return pid

    def _rows(self):
        r = self.client.get("/documents/library")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()


class LibraryTests(_Base):
    def test_a_row_says_who_it_is_for_and_its_company_and_carries_no_content(self):
        doc = self.client.post("/documents", json={"title": "Agreement", "employeeId": "emp-1", "entityId": "ent-1",
                                                   "content": _content("Body.")}).json()
        row = next(r for r in self._rows() if r["id"] == doc["id"])
        self.assertEqual(row["forName"], "Jordan Lee")
        self.assertEqual(row["company"], "Greens Global")
        self.assertNotIn("content", row)
        self.assertTrue(row["canManage"])

    def test_a_document_and_its_envelope_are_one_row_with_the_signing_progress(self):
        doc = self.client.post("/documents", json={"title": "Agreement"}).json()
        rid = self._envelope(title="Agreement")
        self._party(rid, OTHER, "Jordan Lee", 1, status="signed")
        self._party(rid, "signer@partner.example", "Sam Rivera", 2)
        self._party(rid, "copy@partner.example", "Copy Only", 3, status="waiting", role="cc")
        self.client.patch(f"/documents/{doc['id']}", json={"signRequestId": rid})
        rows = [r for r in self._rows() if r["title"] == "Agreement"]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["signed"], rows[0]["signers"]), (1, 2))   # a CC is not a signer
        self.assertEqual(rows[0]["signStatus"], "pending")

    def test_an_envelope_with_no_document_is_listed_for_its_party_and_says_it_is_their_turn(self):
        rid = self._envelope(title="Lease")
        pid = self._party(rid, STAFF, "Staff Person")
        self.as_user(STAFF)
        row = next(r for r in self._rows() if r["id"] == f"sign:{rid}")
        self.assertTrue(row["myTurn"])
        self.assertEqual(row["partyId"], pid)
        self.assertEqual([p["name"] for p in row["parties"]], ["Staff Person"])

    def test_someone_not_on_the_envelope_sees_the_status_but_not_the_people(self):
        doc = self.client.post("/documents", json={"title": "Shared"}).json()
        rid = self._envelope(title="Shared")
        self._party(rid, OTHER, "Jordan Lee")
        self.client.patch(f"/documents/{doc['id']}", json={"signRequestId": rid})
        self.as_user(STAFF)
        rows = {r["id"]: r for r in self._rows()}
        self.assertEqual(rows[doc["id"]]["signStatus"], "pending")
        self.assertEqual(rows[doc["id"]]["parties"], [])
        self.assertFalse(rows[doc["id"]]["canManage"])
        self.assertEqual(rows[doc["id"]]["partyId"], "")

    def test_an_envelope_someone_is_not_on_never_lists_for_them(self):
        rid = self._envelope(title="Private Sale", created_by=OTHER)
        self._party(rid, OTHER, "Jordan Lee")
        self.as_user(STAFF)
        self.assertNotIn(f"sign:{rid}", [r["id"] for r in self._rows()])

    def test_other_peoples_time_sheets_and_reviews_never_list(self):
        for kind in ("timesheet", "perf_review"):
            rid = self._envelope(title=f"Secret {kind}", created_by=OTHER, link_kind=kind)
            self._party(rid, OTHER, "Jordan Lee")
        self.assertEqual([r for r in self._rows() if r["title"].startswith("Secret")], [])

    def test_a_wizard_generated_pdf_is_plumbing_and_never_lists(self):
        tpl = self.client.post("/documents/templates", json={"name": "T", "content": _content("x")}).json()
        doc = self.client.post("/documents", json={"title": "Plumbing", "templateId": tpl["id"], "forSignature": True}).json()
        self.assertNotIn(doc["id"], [r["id"] for r in self._rows()])

    def test_a_pending_envelope_past_its_date_reads_expired_without_writing(self):
        rid = self._envelope(title="Old Ask", expires_on="2020-01-01")
        self._party(rid, ADMIN, "Admin")
        row = next(r for r in self._rows() if r["id"] == f"sign:{rid}")
        self.assertEqual(row["signStatus"], "expired")
        db = database.SessionLocal()
        self.assertEqual(db.query(models.HrSignRequest).filter_by(id=rid).first().status, "pending")
        db.close()


class OnePublishTests(_Base):
    def _template(self, **kw):
        body = {"name": "Offer", "category": "hr", "content": _content("Version one."), **kw}
        r = self.client.post("/documents/templates", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_one_status_per_template(self):
        draft = self._template(status="draft")
        self.assertEqual(draft["state"], "draft")
        live = self._template()
        self.assertEqual(live["state"], "published")
        edited = self.client.patch(f"/documents/templates/{live['id']}", json={"content": _content("Version two.")}).json()
        self.assertEqual(edited["state"], "changes")
        archived = self.client.patch(f"/documents/templates/{live['id']}", json={"status": "archived"}).json()
        self.assertEqual(archived["state"], "archived")

    def test_publishing_a_draft_is_the_one_step_that_makes_it_usable(self):
        draft = self._template(status="draft")
        self.assertEqual(self.client.post("/documents", json={"title": "No", "templateId": draft["id"]}).status_code, 409)
        out = self.client.post(f"/documents/templates/{draft['id']}/publish", json={}).json()
        self.assertEqual((out["status"], out["state"], out["publishedVersion"]), ("active", "published", 1))
        self.assertEqual(self.client.post("/documents", json={"title": "Yes", "templateId": draft["id"]}).status_code, 200)

    def test_an_archived_template_is_restored_before_it_is_published(self):
        t = self._template()
        self.client.patch(f"/documents/templates/{t['id']}", json={"status": "archived"})
        self.assertEqual(self.client.post(f"/documents/templates/{t['id']}/publish", json={}).status_code, 409)

    def test_a_document_is_made_from_the_published_wording_not_an_edit_in_progress(self):
        t = self._template(fieldDefs=[])
        self.client.patch(f"/documents/templates/{t['id']}", json={
            "content": _content("Half written."),
            "fieldDefs": [{"token": "salary", "label": "Salary", "type": "text", "required": True}]})
        r = self.client.post("/documents", json={"title": "From Published", "templateId": t["id"]})
        self.assertEqual(r.status_code, 200, r.text)                       # the new required field is not asked yet
        self.assertIn("Version one", str(r.json()["content"]))
        self.assertEqual(r.json()["templateVersion"], 1)
        self.client.post(f"/documents/templates/{t['id']}/publish", json={})
        self.assertEqual(self.client.post("/documents", json={"title": "Now", "templateId": t["id"]}).status_code, 422)

    def _legacy(self):
        db = database.SessionLocal()
        db.add(models.DocTemplate(id="legacy-1", name="Legacy NDA", category="legal", status="active", version=3,
                                  content=_content("Old wording."), department=""))
        db.commit()
        db.close()

    def test_a_legacy_live_template_reads_published_and_is_released_as_it_stands(self):
        self._legacy()
        row = self.client.get("/documents/templates/legacy-1").json()
        self.assertEqual(row["state"], "published")
        db = database.SessionLocal()
        tpl = db.query(models.DocTemplate).filter_by(id="legacy-1").first()
        content, _, version = documents.published_snapshot(db, tpl)
        db.commit()
        db.close()
        self.assertEqual(version, 3)
        self.assertIn("Old wording", str(content))

    def test_the_first_edit_of_a_legacy_template_keeps_what_it_said_released(self):
        self._legacy()
        edited = self.client.patch("/documents/templates/legacy-1", json={"content": _content("New wording.")}).json()
        self.assertEqual((edited["publishedVersion"], edited["state"]), (3, "changes"))
        doc = self.client.post("/documents", json={"title": "Keeps", "templateId": "legacy-1"}).json()
        self.assertIn("Old wording", str(doc["content"]))

    def test_a_copy_is_a_draft(self):
        t = self._template()
        copy = self.client.post(f"/documents/templates/{t['id']}/duplicate").json()
        self.assertEqual((copy["status"], copy["state"]), ("draft", "draft"))


if __name__ == "__main__":
    unittest.main()


class MineFlagTests(_Base):
    """GET /documents/{id} and /documents/templates/{id} say whether the row is
    the caller's own: the builder drops a blank, unnamed draft on Close only
    when it is (11/11/2026) - never an administrator's reach into someone
    else's."""

    def test_a_document_is_mine_only_for_its_owner(self):
        self.as_user(STAFF)
        did = self.client.post("/documents", json={"title": "Untitled Document"}).json()["id"]
        self.assertTrue(self.client.get(f"/documents/{did}").json()["mine"])
        self.as_user(ADMIN)
        r = self.client.get(f"/documents/{did}").json()
        self.assertEqual(r["access"], "owner")   # an administrator's reach...
        self.assertFalse(r["mine"])              # ...is not ownership

    def test_a_template_is_mine_for_whoever_made_it(self):
        tid = self.client.post("/documents/templates", json={"name": "Untitled Template", "category": "general", "status": "draft"}).json()["id"]
        self.assertTrue(self.client.get(f"/documents/templates/{tid}").json()["mine"])
        self.as_user(STAFF)
        self.assertFalse(self.client.get(f"/documents/templates/{tid}").json()["mine"])
