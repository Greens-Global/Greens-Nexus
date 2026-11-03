"""Knowledge Base, Neil 11/02/2026: a page applies to many departments
(Applies To), an import is filed by rules with no AI (kb_filer), and search,
Ask Nexus and a page's rail walk the link graph (kb_graph). ONE FILE PER
PROCESS."""
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
import kb_blocks  # noqa: E402
import kb_filer  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

MGR = "kbg.manager@example.com"
EMP = "kbg.reader@example.com"


def _blocks(step_titles=("Open the gate", "Check the lock")):
    return kb_blocks.doc([kb_blocks.heading("Purpose"), kb_blocks.paragraph("Hand a unit to a tenant."),
                          kb_blocks.heading("Steps"), kb_blocks.steps([kb_blocks.step(t) for t in step_titles])])


class KbFilingGraphCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            for e, role, first, dept in ((MGR, "manager", "Mary", "Operations"), (EMP, "employee", "Eve", "Maintenance")):
                db.add(models.NexusRole(email=e, role=role, display_name=f"{first} Test"))
                db.add(models.NexusEmployee(id=f"e-{e}", first_name=first, last_name="Test", work_email=e, status="active", deleted_at="",
                                            department=dept, job_title="Site Manager", manager_email=MGR if e != MGR else ""))
            db.add(models.KbCollection(id="col-ops", name="Operations", department="Operations", owner_email=MGR, owner_name="Mary Test",
                                       review_every_months=12, reading_order="[]", active=True))
            db.add(models.KbCollection(id="col-mnt", name="Maintenance", department="Maintenance", owner_email=MGR, owner_name="Mary Test",
                                       review_every_months=12, reading_order="[]", active=True))
            db.add(models.KbCollection(id="col-gate", name="Gate Access", department="", parent_id="col-ops", owner_email=MGR, owner_name="Mary Test",
                                       review_every_months=12, reading_order="[]", active=True))
            db.add(models.KbTag(id="t-keys", name="keys"))
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
        self._as(MGR)

    def tearDown(self):
        auth.SKIP_AUTH = self._skip

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    def _published(self, **kw):
        body = {"title": "Move-In Walkthrough", "page_type": "how_to", "collection_id": "col-ops", "blocks": _blocks()}
        body.update(kw)
        r = self.client.post("/kb/pages", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        p = r.json()
        r = self.client.post(f"/kb/pages/{p['id']}/publish", json={})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    # ── Applies To ───────────────────────────────────────────────────────────
    def test_a_page_defaults_to_its_collections_department_and_takes_many(self):
        p = self._published(title="Lock Check")
        self.assertEqual(p["departments"], ["Operations"])
        r = self.client.patch(f"/kb/pages/{p['id']}", json={"departments": ["Operations", "Maintenance", "Operations"]})
        self.assertEqual(r.json()["departments"], ["Operations", "Maintenance"])
        # a sub-collection inherits its parent's department
        q = self._published(title="Gate Code Reset", collection_id="col-gate")
        self.assertEqual(q["departments"], ["Operations"])

    def test_department_filter_and_also_applies_here(self):
        p = self._published(title="Shared Cleaning Procedure", collection_id="col-mnt", departments=["Maintenance", "Operations"])
        only_mnt = self._published(title="Compressor Service", collection_id="col-mnt")
        self._as(EMP)
        hits = [x["id"] for x in self.client.get("/kb/search", params={"department": "Operations"}).json()["results"]]
        self.assertIn(p["id"], hits)
        self.assertNotIn(only_mnt["id"], hits)
        hits = [x["id"] for x in self.client.get("/kb/pages", params={"department": "Maintenance", "status": "approved"}).json()]
        self.assertIn(only_mnt["id"], hits)   # its collection's department counts
        col = self.client.get("/kb/collections/col-ops").json()
        self.assertIn(p["id"], [x["id"] for x in col["also_applies"]])
        self.assertNotIn(only_mnt["id"], [x["id"] for x in col["also_applies"]])
        self.assertNotIn(p["id"], [x["id"] for x in col["pages"]])   # shelved in Maintenance, shown here as also applying

    # ── the rules filer ──────────────────────────────────────────────────────
    def test_the_filer_reads_type_departments_and_collection_from_the_text(self):
        cols = [{"id": "col-ops", "name": "Operations", "department": "Operations", "parent_id": ""},
                {"id": "col-gate", "name": "Gate Access", "department": "", "parent_id": "col-ops"},
                {"id": "col-mnt", "name": "Maintenance", "department": "Maintenance", "parent_id": ""}]
        depts = ["Operations", "Maintenance", "HR"]
        text = "Gate access after hours\nFor the Operations and Maintenance teams.\n1. Check the keys log.\n2. Open the gate.\n3. Close it behind you."
        s = kb_filer.suggest(title="Gate Access After Hours", text=text, collections=cols, departments=depts, tags=["keys", "forklift"])
        self.assertEqual(s["page_type"], "sop")
        self.assertEqual(s["departments"], ["Operations", "Maintenance"])
        self.assertEqual(s["collection_id"], "col-gate")   # the longest named collection wins over its parent
        self.assertEqual(s["tags"], ["keys"])
        self.assertTrue(s["reasons"]["page_type"] and s["reasons"]["collection"])
        pol = kb_filer.suggest(title="Attendance Policy", text="Everyone must clock in. Violations are disciplinary.", collections=cols, departments=depts, tags=[])
        self.assertEqual(pol["page_type"], "policy")
        self.assertEqual(pol["collection_id"], "")   # nothing named: ask the author
        mine = kb_filer.suggest(title="Reset a Gate Code", text="Open the keypad.", collections=cols, departments=depts, tags=[], my_department="HR")
        self.assertEqual(mine["page_type"], "how_to")
        self.assertEqual(mine["departments"], ["HR"])   # falls back to the importer's own department
        # "HR" never matches inside another word
        self.assertEqual(kb_filer.departments_for("Three things", "thread", depts)[0], [])

    def test_import_as_is_comes_back_filed(self):
        body = {"type": "doc", "content": [{"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "Maintenance Lockout Procedure"}]},
                                            {"type": "orderedList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": f"Step {i}"}]}]} for i in range(1, 5)]}]}
        r = self.client.post("/kb/import/convert", json={"body": body, "title": ""})
        self.assertEqual(r.status_code, 200, r.text)
        s = r.json()["suggested"]
        self.assertEqual(s["page_type"], "sop")
        self.assertEqual(s["departments"], ["Maintenance"])
        self.assertEqual(s["collection_id"], "col-mnt")
        self.assertEqual(s["by"], "rules")

    # ── the graph ────────────────────────────────────────────────────────────
    def test_search_ask_and_the_rail_walk_one_link_out(self):
        a = self._published(title="Forklift Pre-Start Check", blocks=kb_blocks.doc([kb_blocks.paragraph("Inspect the forklift forks and horn before the shift.")]))
        b = self._published(title="Warehouse Safety Rules", collection_id="col-mnt",
                            blocks=kb_blocks.doc([kb_blocks.paragraph("Hard hats on. Keep the aisles clear of pallets.")]))
        self.client.patch(f"/kb/pages/{a['id']}", json={"related_ids": [b["id"]]})
        self._as(EMP)
        res = self.client.get("/kb/search", params={"q": "forklift"}).json()
        self.assertEqual([x["id"] for x in res["results"]], [a["id"]])
        linked = {x["id"]: x["why"] for x in res["linked"]}
        self.assertIn(b["id"], linked)
        self.assertIn("See Also", linked[b["id"]])
        ask = self.client.post("/kb/ask", json={"question": "what do I check on the forklift"}).json()
        self.assertTrue(ask["offline"])   # AI is off; the sources still carry the linked page
        ids = [s["id"] for s in ask["sources"]]
        self.assertEqual(ids[0], a["id"])
        self.assertIn(b["id"], ids)   # joined through the link, not the words
        self.assertIn("See Also", next(s for s in ask["sources"] if s["id"] == b["id"])["why"])
        page_b = self.client.get(f"/kb/pages/{b['id']}").json()
        self.assertIn(a["id"], [x["id"] for x in page_b["around"]])   # the reverse link, nobody picked it by hand
        page_a = self.client.get(f"/kb/pages/{a['id']}").json()
        self.assertNotIn(b["id"], [x["id"] for x in page_a["around"]])   # already under See Also


if __name__ == "__main__":
    unittest.main()
