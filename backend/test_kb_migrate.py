"""Knowledge Base rebuild: the migration keeps every record. Dry run changes
nothing; apply converts, is idempotent, and never touches the old body.
ONE FILE PER PROCESS."""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

import database  # noqa: E402
import kb_blocks  # noqa: E402
import kb_migrate  # noqa: E402
import models  # noqa: E402

GUIDED = {
    "purpose": "Hand a unit to a new tenant.", "scopeText": "All sites.",
    "materials": ["Lock", "Two keys"], "responsibilities": [{"role": "Site Manager", "duty": "Runs the walkthrough"}],
    "definitions": [{"term": "Overlock", "def": "A second lock the site adds"}],
    "procedure": [{"text": "Walk the tenant to the unit", "detail": "- gate code active\n- test the keypad", "image": ""},
                  {"text": "PHOTOS", "detail": ""},
                  {"text": "Take the four standard photos", "detail": "Door open, left, right, back", "image": "sop/abc123.jpg"}],
    "safety": ["Never let the tenant use their own lock before the lease is signed"],
    "references": ["Lease template"], "tables": [{"title": "Lock sizes", "headers": ["Unit", "Lock"], "rows": [["5x5", "Disc"], ["10x10", "Disc"]]}],
    "media": [{"url": "https://youtu.be/abc", "title": "Walkthrough video"}],
    "authoringMode": "guided", "linkedDocumentId": "",
}


class KbMigrateCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        db = database.SessionLocal()
        try:
            db.add(models.NexusEmployee(id="e1", first_name="Omar", last_name="Owner", work_email="owner@example.com", status="active", deleted_at=""))
            db.add(models.KbService(id="svc-1", department="Operations", name="Site Operations", active=True, sort_order=1))
            db.add(models.KbDocument(id="kb_g", doc_code="OPS-014", title="Move-In Walkthrough", doc_type="SOP", departments="Operations", service="Site Operations",
                                     status="approved", owner_email="owner@example.com", version="2.0", effective_date="2026-01-10", body=json.dumps(GUIDED),
                                     revision_history=json.dumps([{"version": "2.0", "date": "2026-03-01", "author": "owner@example.com", "notes": "Approved & published."},
                                                                  {"version": "1.0", "date": "2026-01-10", "author": "owner@example.com", "notes": "Created."}]),
                                     require_ack=True, views=12, review_every_months=12, verified_at="2026-03-01", tags="keys", content_text="old text"))
            db.add(models.KbSnapshot(id="snap-1", doc_id="kb_g", version="1.0", date="2026-01-10", author="owner@example.com", title="Move-In Walkthrough", body=json.dumps({**GUIDED, "purpose": "Old purpose"})))
            db.add(models.KbSnapshot(id="snap-2", doc_id="kb_g", version="2.0", date="2026-03-01", author="owner@example.com", title="Move-In Walkthrough", body=json.dumps(GUIDED)))
            db.add(models.KbSnapshot(id="snap-0", doc_id="kb_g", version="1.0", date="2026-01-10", author="owner@example.com", title="Move-In Walkthrough", body=json.dumps(GUIDED)))
            db.add(models.KbAcknowledgement(id="ack-1", doc_id="kb_g", version="2.0", user_email="lee@example.com", user_name="Lee", signed_at="2026-03-05T10:00:00"))
            db.add(models.KbAcknowledgement(id="ack-2", doc_id="kb_g", version="1.0", user_email="lou@example.com", user_name="Lou", signed_at="2026-01-20T10:00:00"))
            # a Full Editor page linked to a Document Builder document
            db.add(models.Document(id="doc-ff", title="IT Use Policy", content={"pages": [{"json": {"type": "doc", "content": [
                {"type": "styledHeading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Rules"}]},
                {"type": "sectionBox", "attrs": {"label": "Passwords"}, "content": [{"type": "styledParagraph", "content": [{"type": "text", "text": "Use the vault."}]}]},
                {"type": "mergeField", "attrs": {"token": "employee.name"}}]}}]}, status="final", owner_email="owner@example.com"))
            db.add(models.KbDocument(id="kb_f", doc_code="", title="IT Use Policy", doc_type="Guide", departments="IT", status="draft", owner_email="owner@example.com",
                                     version="1.0", body=json.dumps({"authoringMode": "freeform", "linkedDocumentId": "doc-ff"}), revision_history="[]"))
            # a manual with chapters, and an empty draft
            db.add(models.KbDocument(id="kb_m", title="Site Manager Manual", doc_type="Manual", departments="Operations,IT", status="approved", owner_email="owner@example.com",
                                     version="abc", body=json.dumps({"chapters": [{"_id": "c1", "title": "Opening", "intro": "Each morning", "sections": [{"kind": "sop", "docId": "kb_g", "title": "Move-In"}, {"kind": "text", "title": "Lights", "body": "Turn them on."}]}]}), revision_history="[]"))
            db.add(models.KbDocument(id="kb_e", title="Empty Draft", doc_type="SOP", departments="", status="draft", owner_email="", version="0.1", body="{}", revision_history="[]"))
            # a course with a completion
            db.add(models.KbCourse(id="crs-1", course_code="LRN-001", title="Site Safety Basics", status="published", overview=json.dumps(["Know the rules"]), recert_months=12,
                                   lessons=json.dumps([{"_id": "l1", "type": "sop", "title": "Move-In", "body": "", "docId": "kb_g"}, {"_id": "l2", "type": "text", "title": "Intro", "body": "Welcome.\n\n1. First\n2. Second"}]),
                                   quiz=json.dumps({"passPct": 80, "questions": [{"_id": "q1", "q": "Gate?", "options": ["A", "B", "C", "D"], "answer": 2, "explanation": "x"}]}),
                                   owner_email="owner@example.com", created_at="2026-02-01", updated_at="2026-02-02"))
            db.add(models.KbCourseProgress(id="prg-1", course_id="crs-1", user_email="lee@example.com", lessons_done=json.dumps(["l1", "l2"]), quiz_score=100, passed=True,
                                           started_at="2026-02-03", completed_at="2026-02-04T09:00:00"))
            db.add(models.KbCourse(id="crs-2", course_code="LRN-002", title="Draft Course", status="draft", lessons="[]", quiz="{}", owner_email="owner@example.com"))
            db.commit()
        finally:
            db.close()

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def test_1_dry_run_reports_and_changes_nothing(self):
        db = database.SessionLocal()
        try:
            rep = kb_migrate.plan(db)
            self.assertTrue(rep["dry_run"])
            rows = {r.get("id") or r.get("name"): r for r in rep["rows"]}
            self.assertEqual(rows["kb_g"]["new_type"], "sop")
            self.assertEqual(rows["kb_g"]["version"], "2.0")
            self.assertEqual(rows["kb_g"]["action"], "convert")
            self.assertEqual(rows["kb_g"]["signatures"], 2)
            self.assertEqual(rows["kb_f"]["mode"], "freeform")
            self.assertEqual(rows["kb_m"]["new_type"], "reference")
            self.assertEqual(rows["kb_m"]["version"], "1.0")   # published with a bad version string
            self.assertTrue(any("manual" in n for n in rows["kb_m"]["notes"]))
            self.assertEqual(rows["kb_e"]["action"], "needs a look")
            self.assertEqual(rows["Operations"]["action"], "create")
            self.assertEqual(rows["Operations"]["owner"], "owner@example.com")
            self.assertEqual(rows["crs-1"]["completions"], 1)
            self.assertEqual(rep["summary"]["pages"], {"convert": 3, "needs a look": 1})
            # nothing written
            d = db.query(models.KbDocument).filter(models.KbDocument.id == "kb_g").first()
            self.assertEqual(d.blocks, "")
            self.assertEqual(d.migrated_at, "")
            self.assertEqual(db.query(models.KbCollection).count(), 0)
        finally:
            db.close()

    def test_2_apply_converts_keeps_the_old_body_and_is_idempotent(self):
        db = database.SessionLocal()
        try:
            rep = kb_migrate.apply(db, actor="test")
            self.assertFalse(rep["dry_run"])
            d = db.query(models.KbDocument).filter(models.KbDocument.id == "kb_g").first()
            self.assertEqual(json.loads(d.body), GUIDED)            # untouched
            self.assertEqual(d.doc_type, "SOP")                     # untouched
            self.assertEqual((d.major, d.minor), (2, 0))
            self.assertEqual(d.page_type, "sop")
            self.assertTrue(d.migrated_at)
            blocks = kb_blocks.loads(d.blocks)
            text = kb_blocks.plain_text(blocks)
            for must in ("Hand a unit to a new tenant", "Overlock", "A second lock", "Walk the tenant to the unit", "gate code active",
                         "Take the four standard photos", "Never let the tenant", "Lease template", "5x5", "Site Manager", "Runs the walkthrough"):
                self.assertIn(must, text, must)
            steps = kb_blocks.step_list(blocks)
            self.assertEqual([s["title"] for s in steps], ["Walk the tenant to the unit", "Take the four standard photos"])
            self.assertEqual(steps[0]["detail"], "gate code active\ntest the keypad")
            self.assertIn("Photos", [h["text"] for h in kb_blocks.headings(blocks)])   # the ALL-CAPS step became a heading
            self.assertTrue(any(n["type"] == "video" for n in blocks["content"]))
            self.assertEqual(d.tags, "keys")                        # a single department adds no tag
            # collections: department + service under it
            ops = db.query(models.KbCollection).filter(models.KbCollection.department == "Operations").first()
            svc = db.query(models.KbCollection).filter(models.KbCollection.legacy_service_id == "svc-1").first()
            self.assertEqual(svc.parent_id, ops.id)
            self.assertEqual(d.collection_id, svc.id)
            self.assertEqual(ops.owner_email, "owner@example.com")
            # versions: two distinct versions, duplicate 1.0 snapshot folded, order fixed
            vers = db.query(models.KbPageVersion).filter(models.KbPageVersion.doc_id == "kb_g").all()
            self.assertEqual(sorted(v.version for v in vers), ["1.0", "2.0"])
            v1 = next(v for v in vers if v.version == "1.0")
            self.assertIn("Old purpose", v1.content_text)
            # signatures carry the version signed
            sigs = {s.user_email: s for s in db.query(models.KbSignature).filter(models.KbSignature.doc_id == "kb_g").all()}
            self.assertEqual(sigs["lee@example.com"].major, 2)
            self.assertEqual(sigs["lou@example.com"].major, 1)
            self.assertEqual(sigs["lee@example.com"].method, "legacy")
            # history -> events
            kinds = [e.kind for e in db.query(models.KbEvent).filter(models.KbEvent.doc_id == "kb_g").order_by(models.KbEvent.created_at).all()]
            self.assertEqual(kinds, ["created", "published"])
            # freeform: linked document copied, builder nodes flattened
            f = db.query(models.KbDocument).filter(models.KbDocument.id == "kb_f").first()
            ft = kb_blocks.plain_text(kb_blocks.loads(f.blocks))
            self.assertIn("Rules", ft)
            self.assertIn("Passwords", ft)
            self.assertIn("Use the vault", ft)
            self.assertIn("{{employee.name}}", ft)
            self.assertEqual(f.page_type, "how_to")
            self.assertEqual(json.loads(f.body)["linkedDocumentId"], "doc-ff")   # link kept
            # manual: chapters -> headings, SOP section -> embedded page; multi-department -> tags
            m = db.query(models.KbDocument).filter(models.KbDocument.id == "kb_m").first()
            self.assertEqual((m.major, m.minor), (1, 0))
            self.assertEqual(kb_blocks.embedded_page_ids(kb_blocks.loads(m.blocks)), ["kb_g"])
            self.assertIn("IT", m.tags.split(","))
            # course: version 1, lessons renormalized, answers as lists, certificate for the completion
            c = db.query(models.KbCourse).filter(models.KbCourse.id == "crs-1").first()
            self.assertEqual(c.major, 1)
            lessons = json.loads(c.lessons)
            self.assertEqual(lessons[0]["type"], "page")
            self.assertEqual(lessons[0]["docVersion"], "2.0")
            self.assertEqual(lessons[1]["type"], "text")
            self.assertIn("Welcome", kb_blocks.plain_text(lessons[1]["blocks"]))
            self.assertEqual(json.loads(c.quiz)["questions"][0]["answer"], [2])
            self.assertEqual(db.query(models.KbCourseVersion).filter(models.KbCourseVersion.course_id == "crs-1").count(), 1)
            cert = db.query(models.KbCertificate).filter(models.KbCertificate.course_id == "crs-1").first()
            self.assertTrue(cert.legacy)
            self.assertEqual(cert.issued_at, "2026-02-04T09:00:00")
            self.assertEqual(cert.expires_at, "2027-02-04")
            self.assertEqual(db.query(models.KbCourseProgress).filter(models.KbCourseProgress.id == "prg-1").first().certificate_id, cert.id)
            c2 = db.query(models.KbCourse).filter(models.KbCourse.id == "crs-2").first()
            self.assertEqual(c2.major, 0)
            self.assertTrue(c2.draft)
            # second run: nothing new
            before = (db.query(models.KbPageVersion).count(), db.query(models.KbSignature).count(), db.query(models.KbCertificate).count(), db.query(models.KbCollection).count())
            rep2 = kb_migrate.apply(db, actor="test")
            self.assertEqual(rep2["summary"]["pages"], {"already migrated": 4})
            after = (db.query(models.KbPageVersion).count(), db.query(models.KbSignature).count(), db.query(models.KbCertificate).count(), db.query(models.KbCollection).count())
            self.assertEqual(before, after)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
