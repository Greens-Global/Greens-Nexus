"""Comments on a Documents editor page (routers/doc_comments.py).

Whoever may read the document may comment and reply; the author edits, the
author / owner / administrator resolves, the author / administrator deletes
(a root takes its replies with it); the owner is belled once per comment
from someone else, the thread's author on a reply; a template's comments
follow the template.

    python -m pytest test_doc_comments.py
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
from fastapi.testclient import TestClient  # noqa: E402
import main              # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

ADMIN = "comments.admin@greensglobal.com"
OWNER = "comments.owner@greensglobal.com"
READER = "comments.reader@greensglobal.com"


class DocCommentTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        db = database.SessionLocal()
        for m in (models.Document, models.DocTemplate, models.DocComment, models.NexusNotification,
                  models.NexusRole, models.NexusEmployee):
            db.query(m).delete()
        db.add(models.NexusRole(email=ADMIN, role="owner"))
        self.did = f"doc-{uuid.uuid4()}"
        db.add(models.Document(id=self.did, title="Vendor Agreement", owner_email=OWNER, created_by=OWNER,
                               content={"pages": []}, status="draft"))
        self.tid = f"tpl-{uuid.uuid4()}"
        db.add(models.DocTemplate(id=self.tid, name="Offer Letter", created_by=OWNER, content={"pages": []}))
        db.commit()
        db.close()
        auth._role_cache.clear()
        self.as_user(OWNER)

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def as_user(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth._role_cache.clear()

    def _post(self, body, quote="", parent="", kind="document"):
        base = f"/documents/{self.did}" if kind == "document" else f"/documents/templates/{self.tid}"
        r = self.client.post(f"{base}/comments", json={"body": body, "quote": quote, "parentId": parent})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _bells(self, to):
        db = database.SessionLocal()
        try:
            return [n.title for n in db.query(models.NexusNotification)
                    .filter(models.NexusNotification.recipient == to).all()]
        finally:
            db.close()

    def test_comment_reply_resolve_and_list(self):
        root = self._post("Should this be net 30?", quote="payment within 45 days")
        self.assertEqual(root["quote"], "payment within 45 days")
        self.as_user(ADMIN)
        reply = self._post("Yes, change it.", parent=root["id"])
        self.assertEqual(reply["parentId"], root["id"])
        rows = self.client.get(f"/documents/{self.did}/comments").json()
        self.assertEqual([r["body"] for r in rows], ["Should this be net 30?", "Yes, change it."])
        r = self.client.patch(f"/documents/{self.did}/comments/{root['id']}", json={"resolved": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["resolvedAt"])
        self.assertEqual(r.json()["resolvedBy"], ADMIN)

    def test_a_reply_cannot_be_replied_to_or_resolved(self):
        root = self._post("Root")
        reply = self._post("Reply", parent=root["id"])
        r = self.client.post(f"/documents/{self.did}/comments", json={"body": "Nested", "parentId": reply["id"]})
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(f"/documents/{self.did}/comments/{reply['id']}", json={"resolved": True})
        self.assertEqual(r.status_code, 400)

    def test_only_the_author_edits_and_only_author_or_admin_deletes(self):
        self.as_user(ADMIN)
        root = self._post("Admin's note")
        self.as_user(OWNER)
        r = self.client.patch(f"/documents/{self.did}/comments/{root['id']}", json={"body": "Edited by owner"})
        self.assertEqual(r.status_code, 403)
        r = self.client.delete(f"/documents/{self.did}/comments/{root['id']}")
        self.assertEqual(r.status_code, 403)
        self.as_user(ADMIN)
        r = self.client.patch(f"/documents/{self.did}/comments/{root['id']}", json={"body": "Edited by author"})
        self.assertEqual(r.json()["body"], "Edited by author")
        self._post("A reply", parent=root["id"])
        r = self.client.delete(f"/documents/{self.did}/comments/{root['id']}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.client.get(f"/documents/{self.did}/comments").json(), [])

    def test_empty_and_oversized_bodies_are_refused(self):
        r = self.client.post(f"/documents/{self.did}/comments", json={"body": "   "})
        self.assertEqual(r.status_code, 400)
        r = self.client.post(f"/documents/{self.did}/comments", json={"body": "x" * 4001})
        self.assertEqual(r.status_code, 400)

    def test_owner_and_thread_author_are_belled_never_yourself(self):
        root = self._post("Owner's own comment")
        self.assertEqual(self._bells(OWNER), [])
        self.as_user(ADMIN)
        self._post("Admin replies", parent=root["id"])
        self.assertEqual(self._bells(OWNER), ["New Reply on Vendor Agreement"])
        self.assertEqual(self._bells(ADMIN), [])

    def test_template_comments_follow_the_template(self):
        c = self._post("Template wording question", quote="at-will", kind="template")
        self.assertEqual(c["docKind"], "template")
        rows = self.client.get(f"/documents/templates/{self.tid}/comments").json()
        self.assertEqual(len(rows), 1)
        self.assertEqual(self.client.get(f"/documents/{self.did}/comments").json(), [])

    def test_unknown_document_is_404(self):
        r = self.client.get("/documents/nope/comments")
        self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
