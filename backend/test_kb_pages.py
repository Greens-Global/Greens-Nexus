"""Knowledge Base rebuild: pages, publishing rules, revisions, drafts and
walls, sign-offs, flags, search, Start as Task. ONE FILE PER PROCESS."""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

MGR = "kbt.manager@example.com"      # manager role: author + manage
REV = "kbt.reviewer@example.com"     # manager role: the named reviewer
AUT = "kbt.author@example.com"       # employee with the sop:editor grant
EMP = "kbt.reader@example.com"       # employee, reads only
OWN = "kbt.owner@example.com"        # employee who owns a collection


def _blocks(step_titles=("Open the gate", "Check the lock")):
    import kb_blocks
    return kb_blocks.doc([kb_blocks.heading("Purpose"), kb_blocks.paragraph("Hand a unit to a tenant."),
                          kb_blocks.heading("Steps"), kb_blocks.steps([kb_blocks.step(t) for t in step_titles])])


class KbPagesCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            for e, role, first in ((MGR, "manager", "Mary"), (REV, "manager", "Rita"), (AUT, "employee", "Al"), (EMP, "employee", "Eve"), (OWN, "employee", "Omar")):
                db.add(models.NexusRole(email=e, role=role, display_name=f"{first} Test"))
                db.add(models.NexusEmployee(id=f"e-{e}", first_name=first, last_name="Test", work_email=e, status="active", deleted_at="",
                                            department="Operations", job_title="Site Manager", manager_email=MGR if e != MGR else ""))
            db.add(models.NexusGroup(id="g-kb-auth", name="KB Authors", allowed_modules="sop:editor"))
            db.add(models.NexusGroupMember(group_id="g-kb-auth", email=AUT))
            db.add(models.NexusGroupMember(group_id="g-kb-auth", email=OWN))
            db.add(models.KbCollection(id="col-ops", name="Operations", department="Operations", owner_email=OWN, owner_name="Omar Test",
                                       review_every_months=12, reading_order="[]", active=True))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    def _create(self, who=AUT, **kw):
        self._as(who)
        body = {"title": "Move-In Walkthrough", "page_type": "sop", "collection_id": "col-ops", "blocks": _blocks(), "reviewer_email": REV}
        body.update(kw)
        r = self.client.post("/kb/pages", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    # ── drafts, visibility, walls ────────────────────────────────────────────
    def test_reader_cannot_create_but_author_can(self):
        self._as(EMP)
        self.assertEqual(self.client.post("/kb/pages", json={"title": "x"}).status_code, 403)
        page = self._create()
        self.assertEqual(page["status"], "draft")
        self.assertEqual(page["version"], "0.1")
        self.assertEqual(page["owner_email"], AUT)

    def test_a_draft_is_invisible_to_readers_and_visible_to_its_reviewer(self):
        page = self._create()
        self._as(EMP)
        self.assertEqual(self.client.get(f"/kb/pages/{page['id']}").status_code, 404)
        self.assertNotIn(page["id"], [p["id"] for p in self.client.get("/kb/pages").json()])
        self._as(REV)
        self.assertEqual(self.client.get(f"/kb/pages/{page['id']}").status_code, 200)
        self._as(OWN)   # collection owner sees drafts in the collection
        self.assertEqual(self.client.get(f"/kb/pages/{page['id']}").status_code, 200)

    def test_partial_save_never_wipes_fields_and_stale_rev_is_409(self):
        page = self._create(tags=["keys", "move in"])
        r = self.client.patch(f"/kb/pages/{page['id']}", json={"summary": "Fifteen minutes per unit"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["tags"], ["keys", "move in"])
        self.assertEqual(r.json()["reviewer_email"], REV)
        r2 = self.client.patch(f"/kb/pages/{page['id']}", json={"rev": page["updated_at"], "summary": "late"})
        self.assertEqual(r2.status_code, 409)

    # ── publishing rules ─────────────────────────────────────────────────────
    def test_sop_needs_a_second_person_and_never_its_author(self):
        page = self._create()
        pid = page["id"]
        self.assertEqual(self.client.post(f"/kb/pages/{pid}/publish", json={}).status_code, 403)
        r = self.client.post(f"/kb/pages/{pid}/submit", json={})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "in_review")
        # the author cannot approve their own page even with manage rights
        self._as(AUT)
        self.assertEqual(self.client.post(f"/kb/pages/{pid}/review", json={"decision": "approve"}).status_code, 403)
        # a reader cannot approve
        self._as(EMP)
        self.assertEqual(self.client.post(f"/kb/pages/{pid}/review", json={"decision": "approve"}).status_code, 404)
        # the named reviewer can
        self._as(REV)
        r = self.client.post(f"/kb/pages/{pid}/review", json={"decision": "approve", "note": "Good"})
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(out["status"], "approved")
        self.assertEqual(out["version"], "1.0")
        self.assertTrue(out["code"].startswith("OPS-"))
        self.assertEqual(out["verified_by"], REV)
        self.assertEqual(len(out["versions"]), 1)
        # readers see it now
        self._as(EMP)
        self.assertEqual(self.client.get(f"/kb/pages/{pid}").status_code, 200)
        # the author got the bell
        db = database.SessionLocal()
        try:
            bell = db.query(models.NexusNotification).filter(models.NexusNotification.type == "kb_approved", models.NexusNotification.recipient == AUT, models.NexusNotification.ref_id == pid).first()
            self.assertIsNotNone(bell)
            self.assertEqual(json.loads(bell.action)["sub"], f"page:{pid}")
        finally:
            db.close()

    def test_how_to_publishes_directly_by_its_author(self):
        page = self._create(page_type="how_to", title="Reset a Gate Code")
        r = self.client.post(f"/kb/pages/{page['id']}/publish", json={})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "approved")
        self.assertEqual(r.json()["version"], "1.0")

    def test_request_changes_needs_a_note_and_returns_the_draft(self):
        page = self._create()
        pid = page["id"]
        self.client.post(f"/kb/pages/{pid}/submit", json={})
        self._as(REV)
        self.assertEqual(self.client.post(f"/kb/pages/{pid}/review", json={"decision": "request_changes"}).status_code, 422)
        r = self.client.post(f"/kb/pages/{pid}/review", json={"decision": "request_changes", "note": "Add the photo step"})
        self.assertEqual(r.json()["status"], "changes_requested")
        self._as(AUT)
        r = self.client.patch(f"/kb/pages/{pid}", json={"blocks": _blocks(("Open the gate", "Take the four photos"))})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.client.post(f"/kb/pages/{pid}/submit", json={}).json()["status"], "in_review")

    def test_codes_never_repeat_across_two_approvals(self):
        codes = set()
        for i in range(3):
            page = self._create(title=f"Code test {i}")
            self.client.post(f"/kb/pages/{page['id']}/submit", json={})
            self._as(REV)
            out = self.client.post(f"/kb/pages/{page['id']}/review", json={"decision": "approve"}).json()
            codes.add(out["code"])
        self.assertEqual(len(codes), 3)

    # ── revisions ────────────────────────────────────────────────────────────
    def _published(self, **kw):
        page = self._create(**kw)
        self.client.post(f"/kb/pages/{page['id']}/submit", json={})
        self._as(REV)
        return self.client.post(f"/kb/pages/{page['id']}/review", json={"decision": "approve"}).json()

    def test_editing_a_published_page_is_a_revision_readers_do_not_see(self):
        page = self._published()
        pid = page["id"]
        self._as(AUT)
        self.assertEqual(self.client.patch(f"/kb/pages/{pid}", json={"blocks": _blocks()}).status_code, 409)
        rev = self.client.post(f"/kb/pages/{pid}/revisions").json()
        self.assertEqual(rev["status"], "draft")
        self.assertEqual(rev["base_version"], "1.0")
        r = self.client.patch(f"/kb/revisions/{rev['id']}", json={"blocks": _blocks(("Open the gate", "Check the lock", "Sweep the unit")),
                                                                  "change_kind": "minor", "change_note": "Added sweeping"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["next_version"], "1.1")
        # readers still see 1.0 with two steps
        self._as(EMP)
        live = self.client.get(f"/kb/pages/{pid}").json()
        self.assertEqual(live["version"], "1.0")
        self.assertEqual(len(live["steps"]), 2)
        # submit, approve by the reviewer -> 1.1 with three steps, two versions on file
        self._as(AUT)
        r = self.client.post(f"/kb/revisions/{rev['id']}/submit", json={})
        self.assertEqual(r.json()["status"], "in_review")
        self.assertEqual(self.client.post(f"/kb/revisions/{rev['id']}/review", json={"decision": "approve"}).status_code, 403)
        self._as(REV)
        r = self.client.post(f"/kb/revisions/{rev['id']}/review", json={"decision": "approve"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "merged")
        self._as(EMP)
        live = self.client.get(f"/kb/pages/{pid}").json()
        self.assertEqual(live["version"], "1.1")
        self.assertEqual(len(live["steps"]), 3)
        self.assertEqual([v["version"] for v in live["versions"]], ["1.1", "1.0"])
        old = self.client.get(f"/kb/pages/{pid}/versions/{live['versions'][1]['id']}").json()
        self.assertEqual(old["version"], "1.0")
        self.assertEqual(old["diff"]["added"], ["Sweep the unit"])

    def test_a_major_policy_version_asks_everyone_to_sign_again(self):
        page = self._published(page_type="policy", title="Safety and Conduct Policy")
        pid = page["id"]
        self.assertTrue(page["require_ack"])
        # the reader signs 1.0
        self._as(EMP)
        self.assertEqual(self.client.post(f"/kb/pages/{pid}/sign", json={"typed_name": "Someone Else"}).status_code, 422)
        r = self.client.post(f"/kb/pages/{pid}/sign", json={"typed_name": "Eve Test"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["signed"])
        self.assertTrue(self.client.get(f"/kb/pages/{pid}").json()["signoff"]["signed"])
        # a minor fix keeps the signature
        self._as(AUT)
        rev = self.client.post(f"/kb/pages/{pid}/revisions").json()
        self.client.patch(f"/kb/revisions/{rev['id']}", json={"change_kind": "minor", "blocks": _blocks(("Open the gate", "Check the lock", "Typo fix"))})
        self.client.post(f"/kb/revisions/{rev['id']}/submit", json={})
        self._as(REV)
        self.client.post(f"/kb/revisions/{rev['id']}/review", json={"decision": "approve"})
        self._as(EMP)
        self.assertTrue(self.client.get(f"/kb/pages/{pid}").json()["signoff"]["signed"])
        # a major change does not
        self._as(AUT)
        rev = self.client.post(f"/kb/pages/{pid}/revisions").json()
        self.client.patch(f"/kb/revisions/{rev['id']}", json={"change_kind": "major", "change_note": "Phones away on lifts"})
        self.client.post(f"/kb/revisions/{rev['id']}/submit", json={})
        self._as(REV)
        out = self.client.post(f"/kb/revisions/{rev['id']}/review", json={"decision": "approve"}).json()
        self.assertEqual(out["page"]["version"], "2.0")
        self._as(EMP)
        st = self.client.get(f"/kb/pages/{pid}").json()["signoff"]
        self.assertFalse(st["signed"])
        self.assertEqual(st["version_signed"], "1.0")   # the signature she gave, which covered 1.1 too
        # the tracking list shows the signed-older version for her
        self._as(AUT)
        sigs = self.client.get(f"/kb/pages/{pid}/signatures").json()
        eve = next(u for u in sigs["unsigned"] if u["email"] == EMP)
        self.assertEqual(eve["signed_older"], "1.0")

    def test_the_nexus_sign_switch(self):
        # Off (WP 1.4): nothing sends envelopes, so a page saved with Nexus Sign
        # signs in-page and the option is hidden. On (Release 3): the page says
        # Nexus Sign and the in-page signature is refused.
        import kb_core
        from unittest import mock
        page = self._published(page_type="policy", title="Key Handling Policy")
        db = database.SessionLocal()
        try:
            d = db.query(models.KbDocument).filter(models.KbDocument.id == page["id"]).first()
            d.signing = "nexus_sign"
            db.commit()
        finally:
            db.close()
        with mock.patch.object(kb_core, "NEXUS_SIGN_FOR_POLICIES", False):
            self._as(AUT)
            draft = self._create(page_type="how_to", title="Badge Policy")
            r = self.client.patch(f"/kb/pages/{draft['id']}", json={"signing": "nexus_sign"})
            self.assertEqual((r.json()["signing"], r.json()["nexus_sign_available"]), ("in_page", False))
            self._as(EMP)
            self.assertEqual(self.client.get(f"/kb/pages/{page['id']}").json()["signing"], "in_page")
        with mock.patch.object(kb_core, "NEXUS_SIGN_FOR_POLICIES", True):
            self._as(EMP)
            got = self.client.get(f"/kb/pages/{page['id']}").json()
            self.assertEqual((got["signing"], got["nexus_sign_available"]), ("nexus_sign", True))
            self.assertEqual(got["signoff"]["nexus_sign"]["status"], "")      # the daily run has not sent it yet
            self.assertEqual(self.client.post(f"/kb/pages/{page['id']}/sign", json={"typed_name": "Eve Test"}).status_code, 409)

    # ── Neil's rebuild rules (PR #743) that had no test yet (WP 2.1/2.2, Oct 29 2026) ──
    def test_a_policy_needs_a_second_person_and_a_reference_publishes_directly(self):
        pol = self._create(page_type="policy", title="Visitor Policy")
        self.assertNotEqual(self.client.post(f"/kb/pages/{pol['id']}/publish", json={}).status_code, 200)
        self.assertEqual(self.client.post(f"/kb/pages/{pol['id']}/submit", json={}).status_code, 200)
        self.assertEqual(self.client.post(f"/kb/pages/{pol['id']}/review", json={"decision": "approve"}).status_code, 403)
        self._as(REV)
        r = self.client.post(f"/kb/pages/{pol['id']}/review", json={"decision": "approve"})
        self.assertEqual((r.status_code, r.json().get("status"), r.json().get("version")), (200, "approved", "1.0"))
        ref = self._create(page_type="reference", title="Gate Code List")
        r = self.client.post(f"/kb/pages/{ref['id']}/publish", json={})
        self.assertEqual((r.status_code, r.json().get("status")), (200, "approved"), r.text)

    def test_a_real_change_is_a_major_version_and_review_locks_the_revision(self):
        page = self._published(title="Unit Turnover")
        self._as(AUT)
        rev = self.client.post(f"/kb/pages/{page['id']}/revisions").json()
        r = self.client.patch(f"/kb/revisions/{rev['id']}", json={"blocks": _blocks(("Inspect", "Paint")), "change_kind": "major", "change_note": "New process"})
        self.assertEqual(r.json()["next_version"], "2.0")
        self.assertEqual(self.client.post(f"/kb/revisions/{rev['id']}/submit", json={}).status_code, 200)
        self.assertEqual(self.client.patch(f"/kb/revisions/{rev['id']}", json={"summary": "late edit"}).status_code, 409)

    def test_archived_pages_are_for_authors_and_drafts_for_the_collection_owner(self):
        page = self._create(page_type="how_to", title="Old Lock Codes")
        self.assertEqual(self.client.post(f"/kb/pages/{page['id']}/publish", json={}).status_code, 200)
        self.assertEqual(self.client.post(f"/kb/pages/{page['id']}/archive", json={}).status_code, 403)   # the collection owner or Manage archives
        self._as(MGR)
        r = self.client.post(f"/kb/pages/{page['id']}/archive", json={})
        self.assertEqual(r.status_code, 200, r.text)
        self._as(EMP)
        self.assertEqual(self.client.get(f"/kb/pages/{page['id']}").status_code, 404)
        self._as(AUT)
        self.assertEqual(self.client.get(f"/kb/pages/{page['id']}").status_code, 200)
        draft = self._create(page_type="how_to", title="Draft In Ops")
        self._as(OWN)                                   # owns the Operations collection
        self.assertEqual(self.client.get(f"/kb/pages/{draft['id']}").status_code, 200)
        self._as(EMP)
        self.assertEqual(self.client.get(f"/kb/pages/{draft['id']}").status_code, 404)

    # ── Manage > Health actions (WP 4.3, Oct 29 2026) ───────────────────────
    def test_a_page_request_is_assigned_then_closed_with_a_note(self):
        self._as(EMP)
        self.assertEqual(self.client.post("/kb/requests", json={"query": "How do I reset a gate code?"}).status_code, 201)
        self._as(MGR)
        req = next(r for r in self.client.get("/kb/health").json()["requests"] if r["query"] == "How do I reset a gate code?")
        self.assertEqual(self.client.post(f"/kb/requests/{req['id']}/assign", json={"email": EMP}).status_code, 422)   # not an author
        r = self.client.post(f"/kb/requests/{req['id']}/assign", json={"email": AUT})
        self.assertEqual((r.status_code, r.json()["assigned_to"]), (200, AUT), r.text)
        req = next(x for x in self.client.get("/kb/health").json()["requests"] if x["id"] == req["id"])
        self.assertEqual((req["assigned_to"], req["assigned_name"]), (AUT, "Al Test"))
        db = database.SessionLocal()
        try:
            bell = db.query(models.NexusNotification).filter(models.NexusNotification.recipient == AUT,
                                                             models.NexusNotification.type == "kb_page_request").first()
            self.assertIsNotNone(bell)
        finally:
            db.close()
        self.assertEqual(self.client.post(f"/kb/requests/{req['id']}/close", json={"resolution": "Covered in Gate Codes"}).status_code, 200)
        db = database.SessionLocal()
        try:
            row = db.query(models.KbPageRequest).filter(models.KbPageRequest.id == req["id"]).first()
            self.assertEqual((row.status, row.close_note), ("done", "Covered in Gate Codes"))
            done = db.query(models.NexusNotification).filter(models.NexusNotification.recipient == EMP,
                                                             models.NexusNotification.type == "kb_request_done").first()
            self.assertIn("Covered in Gate Codes", done.body)
        finally:
            db.close()

    # ── search misses and synonyms (WP 4.4, Oct 29 2026) ────────────────────
    def test_a_synonym_from_a_miss_finds_the_page(self):
        page = self._create(page_type="how_to", title="Gate Opening")
        self.assertEqual(self.client.post(f"/kb/pages/{page['id']}/publish", json={}).status_code, 200)
        self._as(EMP)
        self.assertEqual(self.client.get("/kb/search", params={"q": "portcullis"}).json()["total"], 0)
        self.assertEqual(self.client.put("/kb/synonyms", json={"groups": [["portcullis", "gate"]]}).status_code, 403)
        self._as(MGR)
        r = self.client.put("/kb/synonyms", json={"groups": [["Portcullis", "gate", "gate"], ["only-one"]]})
        self.assertEqual(r.json()["groups"], [["portcullis", "gate"]])
        self.assertEqual(self.client.get("/kb/health").json()["synonyms"], [["portcullis", "gate"]])
        self._as(EMP)
        found = self.client.get("/kb/search", params={"q": "portcullis"}).json()
        self.assertIn(page["id"], [x["id"] for x in found["results"]])

    def test_type_ahead_searches_are_never_misses(self):
        self._as(EMP)
        self.client.get("/kb/search", params={"q": "pran", "limit": 5, "log": "false"})
        self.client.get("/kb/search", params={"q": "pranshu birthday"})
        self._as(MGR)
        got = [m["query"] for m in self.client.get("/kb/health").json()["misses"]]
        self.assertNotIn("pran", got)
        self.assertIn("pranshu birthday", got)

    def test_the_first_monday_lists_misses_to_collection_owners(self):
        from datetime import datetime, timezone
        from unittest import mock
        import graph_mail
        import kb_daily

        class FirstMonday(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime(2026, 11, 2, 9, 0, tzinfo=timezone.utc)
        self._as(EMP)
        self.client.get("/kb/search", params={"q": "snow plow schedule"})
        db = database.SessionLocal()
        try:
            import kb_search
            kb_search.log_miss(db, "my payslip is wrong", 0, EMP, source="help")   # typed into Help: never an owner's
            db.query(models.KbReminderLog).delete()
            db.commit()
            with mock.patch.object(kb_daily, "datetime", FirstMonday), mock.patch.object(graph_mail, "DEFAULT_FROM_EMAIL", ""):
                kb_daily.run_owner_digests(db)
            bell = db.query(models.NexusNotification).filter(models.NexusNotification.recipient == OWN,
                                                             models.NexusNotification.type == "kb_owner_digest").first()
            self.assertIsNotNone(bell)
            self.assertIn('no good answer: "snow plow schedule"', bell.body)
            self.assertNotIn("payslip", bell.body)
        finally:
            db.close()

    # ── attachments (WP 5.2, Oct 29 2026) ───────────────────────────────────
    def test_an_attachment_is_kept_found_by_name_and_never_a_data_blob(self):
        import kb_blocks
        doc = kb_blocks.doc([kb_blocks.paragraph("Fill in the form below."),
                             kb_blocks.file_block("https://files.example.com/kb-media/pages/abc.pdf", "Move-In Checklist.pdf", 48213, "application/pdf"),
                             {"type": "file", "attrs": {"url": "data:application/pdf;base64,AAAA", "name": "Smuggled.pdf"}}])
        page = self._create(page_type="how_to", title="Move-In Paperwork", blocks=doc)
        files = [n for n in page["blocks"]["content"] if n["type"] == "file"]
        self.assertEqual([(f["attrs"]["name"], f["attrs"]["size"]) for f in files], [("Move-In Checklist.pdf", 48213)])
        self.assertEqual(self.client.post(f"/kb/pages/{page['id']}/publish", json={}).status_code, 200)
        self._as(EMP)
        found = self.client.get("/kb/search", params={"q": "move-in checklist"}).json()
        self.assertIn(page["id"], [r["id"] for r in found["results"]])

    # ── who may read a page (WP 5.3, Oct 29 2026) ───────────────────────────
    def test_a_page_with_readers_is_hidden_from_everyone_else(self):
        page = self._create(page_type="how_to", title="Payroll Corrections Desk")
        self.assertEqual(self.client.post(f"/kb/pages/{page['id']}/publish", json={}).status_code, 200)
        other = self._create(page_type="how_to", title="Front Desk Hours", related_ids=[page["id"]])
        self.assertEqual(self.client.post(f"/kb/pages/{other['id']}/publish", json={}).status_code, 200)
        r = self.client.patch(f"/kb/pages/{page['id']}", json={"readers": {"people": [REV]}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["readers_text"], "1 named")
        self._as(EMP)
        self.assertEqual(self.client.get(f"/kb/pages/{page['id']}").status_code, 404)
        self.assertNotIn(page["id"], [x["id"] for x in self.client.get("/kb/search", params={"q": "payroll corrections"}).json()["results"]])
        self.assertNotIn(page["id"], [x["id"] for x in self.client.post("/kb/ask", json={"question": "payroll corrections desk"}).json()["sources"]])
        self.assertNotIn(page["id"], [x["id"] for x in self.client.get(f"/kb/pages/{other['id']}").json()["related"]])
        for who in (REV, MGR, OWN, AUT):          # named, Manage, collection owner, its owner
            self._as(who)
            self.assertEqual(self.client.get(f"/kb/pages/{page['id']}").status_code, 200, who)
        self._as(AUT)
        self.client.patch(f"/kb/pages/{page['id']}", json={"readers": {"everyone": True}})
        self._as(EMP)
        self.assertEqual(self.client.get(f"/kb/pages/{page['id']}").status_code, 200)

    # ── page view reports (WP 5.4, Oct 29 2026) ─────────────────────────────
    def test_the_reading_report_counts_views_and_finds_unread_pages(self):
        read = self._create(page_type="how_to", title="Opening Checklist")
        unread = self._create(page_type="how_to", title="Closing Checklist")
        for p in (read, unread):
            self.assertEqual(self.client.post(f"/kb/pages/{p['id']}/publish", json={}).status_code, 200)
        self._as(EMP)
        self.client.get(f"/kb/pages/{read['id']}")
        self.client.get(f"/kb/pages/{read['id']}")
        self.assertEqual(self.client.get("/kb/reports/reading").status_code, 403)   # readers do not get reports
        self._as(MGR)
        rep = self.client.get("/kb/reports/reading", params={"days": 30}).json()
        top = next(x for x in rep["most_read"] if x["id"] == read["id"])
        self.assertEqual((top["views"], top["readers"]), (2, 1))
        self.assertIn(unread["id"], [x["id"] for x in rep["never_opened"]])
        self.assertIn("Operations", [t["department"] for t in rep["by_team"]])
        self.assertNotIn("user_email", str(rep))                                    # counts only, never who

    # ── scheduled publishing (WP 5.8, Oct 29 2026) ──────────────────────────
    def test_a_page_goes_live_on_its_day(self):
        import kb_core
        from unittest import mock
        page = self._create(page_type="how_to", title="Winter Hours")
        self.assertEqual(self.client.post(f"/kb/pages/{page['id']}/publish", json={}).status_code, 200)
        self.assertEqual(self.client.patch(f"/kb/pages/{page['id']}", json={"live_from": "2020-01-01"}).status_code, 422)
        day = kb_core.add_days(kb_core.today(), 3)
        r = self.client.patch(f"/kb/pages/{page['id']}", json={"live_from": day})
        self.assertEqual((r.json()["live_from"], r.json()["is_live"]), (day, False))
        self._as(EMP)
        self.assertEqual(self.client.get(f"/kb/pages/{page['id']}").status_code, 404)
        self.assertNotIn(page["id"], [x["id"] for x in self.client.get("/kb/search", params={"q": "winter hours"}).json()["results"]])
        self._as(AUT)
        self.assertEqual(self.client.get(f"/kb/pages/{page['id']}").status_code, 200)   # its editor sees it
        with mock.patch.object(kb_core, "today", return_value=day):
            self._as(EMP)
            self.assertEqual(self.client.get(f"/kb/pages/{page['id']}").status_code, 200)

    # ── @mentions in comments (WP 5.9, Oct 29 2026) ─────────────────────────
    def test_a_mention_rings_only_someone_who_may_read_the_page(self):
        def mentions_of(who):
            db = database.SessionLocal()
            try:
                return db.query(models.NexusNotification).filter(models.NexusNotification.recipient == who,
                                                                 models.NexusNotification.title == "You Were Mentioned").count()
            finally:
                db.close()
        page = self._create(page_type="how_to", title="Key Log")
        self.assertEqual(self.client.post(f"/kb/pages/{page['id']}/publish", json={}).status_code, 200)
        r = self.client.post(f"/kb/pages/{page['id']}/comments", json={"text": "@Eve Test can you check step 2?", "mentions": [EMP]})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(mentions_of(EMP), 1)
        self.client.patch(f"/kb/pages/{page['id']}", json={"readers": {"people": [REV]}})
        self.client.post(f"/kb/pages/{page['id']}/comments", json={"text": "@Eve Test again", "mentions": [EMP, "nobody@example.com"]})
        self.assertEqual(mentions_of(EMP), 1)                     # Eve may no longer read it: no bell, no title leaked

    # ── export (WP 5.11, Oct 29 2026) ───────────────────────────────────────
    def test_export_holds_the_published_pages_only(self):
        import io
        import docx
        live = self._create(page_type="how_to", title="Exported Gate Steps")
        self.assertEqual(self.client.post(f"/kb/pages/{live['id']}/publish", json={}).status_code, 200)
        self._create(page_type="how_to", title="Unpublished Draft Steps")
        self.assertEqual(self.client.get("/kb/export").status_code, 403)              # an author is not Manage
        self._as(OWN)                                                                   # owns Operations
        r = self.client.get("/kb/export", params={"collection": "col-ops", "format": "docx"})
        self.assertEqual(r.status_code, 200, r.text)
        text = " ".join(p.text for p in docx.Document(io.BytesIO(r.content)).paragraphs)
        self.assertIn("Exported Gate Steps", text)
        self.assertNotIn("Unpublished Draft Steps", text)
        self._as(MGR)
        r = self.client.get("/kb/export", params={"format": "pdf"})
        self.assertEqual((r.status_code, r.headers["content-type"]), (200, "application/pdf"))
        self.assertTrue(r.content.startswith(b"%PDF"))

    # ── uploaded training videos (WP 5.10, Oct 29 2026) ─────────────────────
    def test_a_video_upload_link_is_signed_by_the_server(self):
        from unittest import mock
        import kb_media
        self._as(EMP)
        self.assertEqual(self.client.post("/kb/media/video-upload", json={"content_type": "video/mp4", "size": 1000}).status_code, 403)
        self._as(AUT)
        self.assertEqual(self.client.post("/kb/media/video-upload", json={"content_type": "video/mp4", "size": 1000}).status_code, 503)

        class Resp:
            status_code = 200

            def json(self):
                return {"url": "/object/upload/sign/kb-media/videos/x.mp4?token=tok123"}

        class FakeClient:      # only kb_media's httpx: the test client uses the real one
            def __init__(self, *a, **k):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def post(self, *a, **k):
                return Resp()

        class FakeHttpx:
            Client = FakeClient
        with mock.patch.object(kb_media, "configured", return_value=True),              mock.patch.dict("os.environ", {"SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_KEY": "k"}),              mock.patch.object(kb_media, "httpx", FakeHttpx):
            self.assertEqual(self.client.post("/kb/media/video-upload", json={"content_type": "video/avi", "size": 1000}).status_code, 422)
            self.assertEqual(self.client.post("/kb/media/video-upload", json={"content_type": "video/mp4", "size": 300 * 1024 * 1024}).status_code, 422)
            r = self.client.post("/kb/media/video-upload", json={"content_type": "video/mp4", "size": 5 * 1024 * 1024})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["token"], "tok123")
            self.assertTrue(r.json()["url"].endswith(".mp4"))

    def test_archive_then_restore_lands_in_draft_not_published(self):
        page = self._published()
        self._as(AUT)   # author, not owner/manage
        self.assertEqual(self.client.post(f"/kb/pages/{page['id']}/archive").status_code, 403)
        self._as(OWN)
        self.assertEqual(self.client.post(f"/kb/pages/{page['id']}/archive").json()["status"], "archived")
        self._as(EMP)
        self.assertEqual(self.client.get(f"/kb/pages/{page['id']}").status_code, 404)
        self._as(OWN)
        self.assertEqual(self.client.post(f"/kb/pages/{page['id']}/restore").json()["status"], "draft")

    # ── reading: views, search, flags, pins, start as task ───────────────────
    def test_opening_a_page_writes_one_view_row_and_search_finds_synonyms(self):
        page = self._published(title="Unit Keys and Overlocks")
        pid = page["id"]
        self._as(EMP)
        self.client.get(f"/kb/pages/{pid}")
        self.client.get(f"/kb/pages/{pid}")
        db = database.SessionLocal()
        try:
            rows = db.query(models.KbView).filter(models.KbView.doc_id == pid).all()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0].count, 2)
            self.assertEqual(db.query(models.KbDocument).filter(models.KbDocument.id == pid).first().views, 2)
        finally:
            db.close()
        r = self.client.get("/kb/search", params={"q": "unit key"}).json()
        self.assertIn(pid, [x["id"] for x in r["results"]])
        r = self.client.get("/kb/search", params={"q": "padlock"}).json()   # synonym of lock / overlock
        self.assertIn(pid, [x["id"] for x in r["results"]])
        r = self.client.get("/kb/search", params={"q": "zzzz nothing"}).json()
        self.assertEqual(r["results"], [])

    def test_report_a_problem_reaches_the_owner_and_health(self):
        page = self._published()
        self._as(EMP)
        r = self.client.post(f"/kb/pages/{page['id']}/flag", json={"text": "Step 2 is out of date"})
        self.assertEqual(r.status_code, 201)
        self._as(AUT)
        h = self.client.get("/kb/health").json()
        self.assertEqual(h["flags"][0]["text"], "Step 2 is out of date")
        self.assertEqual(self.client.post(f"/kb/flags/{h['flags'][0]['id']}/resolve", json={"resolution": "Fixed"}).status_code, 200)
        self.assertEqual(self.client.get("/kb/health").json()["stats"]["flags"], 0)

    def test_start_as_task_makes_a_checklist_from_the_steps(self):
        page = self._published()
        self._as(MGR)
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id="g-kb-tasks", name="Tasks", allowed_modules="tasks:editor"))
            db.add(models.NexusGroupMember(group_id="g-kb-tasks", email=MGR))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        r = self.client.post(f"/kb/pages/{page['id']}/start-task", json={"assignee_email": EMP, "due_on": "2026-11-01", "priority": "high"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["steps"], 2)
        db = database.SessionLocal()
        try:
            items = db.query(models.TaskChecklistItem).filter(models.TaskChecklistItem.task_id == r.json()["task_id"]).order_by(models.TaskChecklistItem.position).all()
            self.assertEqual([i.title for i in items], ["Open the gate", "Check the lock"])
            t = db.query(models.Task).filter(models.Task.id == r.json()["task_id"]).first()
            self.assertEqual(t.checklist_total, 2)
            self.assertEqual(t.assignee_email, EMP)
            self.assertEqual(db.query(models.KbTaskLink).filter(models.KbTaskLink.doc_id == page["id"]).count(), 1)
        finally:
            db.close()
        self.assertEqual(self.client.get(f"/kb/pages/{page['id']}/tasks").json()["tasks"][0]["checklist_total"], 2)

    def test_home_lists_what_waits_on_me(self):
        page = self._published(page_type="policy", title="Phone Policy")
        self._as(EMP)
        home = self.client.get("/kb/home").json()
        self.assertIn(page["id"], [p["id"] for p in home["waiting"]["policies"]])
        self.assertTrue(any(c["id"] == "col-ops" for c in home["collections"]))
        self.assertFalse(home["me"]["can_author"])
        self._as(AUT)
        self.assertTrue(self.client.get("/kb/me").json()["can_author"])

    # ── Import As Is: a Word / PDF file, no AI (Oct 29 2026) ─────────────────
    def test_import_as_is_keeps_structure_and_attaches_the_original(self):
        store = "https://proj.supabase.co/storage/v1/object/public/kb-media/imports/"
        word = {"type": "doc", "content": [
            {"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "Gate Lockup"}]},
            {"type": "paragraph", "attrs": {"textAlign": "center"}, "content": [
                {"type": "text", "text": "Lock the ", "marks": [{"type": "textStyle", "attrs": {"fontFamily": "Calibri", "color": "#ff0000"}}]},
                {"type": "text", "text": "main gate", "marks": [{"type": "bold"}]}]},
            {"type": "paragraph"},
            {"type": "orderedList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Close it"}]}]}]},
            {"type": "table", "content": [{"type": "tableRow", "content": [
                {"type": "tableCell", "attrs": {"backgroundColor": "#eee"}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Key"}]}]}]}]},
            {"type": "image", "attrs": {"src": store + "a.png"}},
            {"type": "image", "attrs": {"src": "data:image/png;base64,AAAA"}},
            {"type": "pageBreak"},
            {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "After Hours"}]},
        ]}
        self._as(EMP)
        self.assertEqual(self.client.post("/kb/import/convert", json={"body": word}).status_code, 403)
        self._as(AUT)
        old = os.environ.get("SUPABASE_URL")
        os.environ["SUPABASE_URL"] = "https://proj.supabase.co"
        try:
            r = self.client.post("/kb/import/convert", json={"body": word, "title": "gate lockup v3",
                                                             "original": {"url": store + "b.docx", "name": "Gate Lockup v3.docx", "size": 2048, "mime": "x"}})
        finally:
            if old is None:
                os.environ.pop("SUPABASE_URL", None)
            else:
                os.environ["SUPABASE_URL"] = old
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(out["title"], "Gate Lockup")          # the file's own title line
        types = [n["type"] for n in out["blocks"]["content"]]
        self.assertEqual(types, ["paragraph", "orderedList", "table", "image", "horizontalRule", "heading", "heading", "file"])
        para = out["blocks"]["content"][0]["content"]
        self.assertEqual([m["type"] for m in para[1]["marks"]], ["bold"])
        self.assertNotIn("marks", para[0])                      # fonts and colors are not copied
        self.assertNotIn("data:", json.dumps(out["blocks"]))    # a data: picture never lands on a page
        self.assertEqual(out["blocks"]["content"][-1]["attrs"]["name"], "Gate Lockup v3.docx")
        self.assertEqual((out["tables"], out["images"]), (1, 1))
        # an outside URL is never attached as the "original"
        r = self.client.post("/kb/import/convert", json={"body": word, "original": {"url": "https://evil.example.com/x.docx", "name": "x"}})
        self.assertNotIn("file", [n["type"] for n in r.json()["blocks"]["content"]])
        # the result opens as an ordinary draft
        page = self._create(title=out["title"], page_type="how_to", blocks=out["blocks"])
        self.assertEqual(page["status"], "draft")

    def test_pasted_text_imports_without_ai_warnings(self):
        import kb_ai
        self._as(AUT)
        self.assertFalse(kb_ai.available())
        r = self.client.post("/kb/import", json={"text": "OPENING\n\n1. Unlock the door\n2. Turn on the lights"})
        self.assertEqual(r.status_code, 202, r.text)
        job = self.client.get(f"/kb/jobs/{r.json()['id']}").json()
        self.assertEqual(job["status"], "done")
        self.assertEqual(job["result"]["warnings"], [])
        self.assertIn("orderedList", [n["type"] for n in job["result"]["blocks"]["content"]])


if __name__ == "__main__":
    unittest.main()
