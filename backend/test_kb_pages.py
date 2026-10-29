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


if __name__ == "__main__":
    unittest.main()
