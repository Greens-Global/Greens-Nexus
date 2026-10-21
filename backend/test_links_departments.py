"""Links departments (Neil, Oct 21 2026): "Storage" is "Operations", and
Human Resources and Marketing are departments.

The startup migration (main._run_migrations, SQLite list here; the Postgres
list is its twin) rewrites the picker row, every link tagged Storage (the
JSON list and the legacy singular column), Personal Links and saved Link View
filters - idempotently - and the router's write paths alias a stray
"storage" so it never comes back.

    python -m pytest test_links_departments.py
"""
import os
import unittest

import _testdb  # noqa: F401 - a throwaway SQLite, never greens_nexus.db; keep first

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import external_links as el  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

ADMIN = {"email": "admin@greensglobal.com", "role": "owner", "level": 5}


def _seed_storage_rows(db):
    db.query(models.ExternalLink).delete()
    db.query(models.ExternalLinkTaxonomy).delete()
    db.query(models.PersonalLink).delete()
    db.query(models.LinkLayoutView).delete()
    db.add(models.ExternalLinkTaxonomy(id="dept-storage", kind="department", name="Storage", sort_order=4, created_at=""))
    db.add(models.ExternalLinkTaxonomy(id="dept-accounting", kind="department", name="Accounting", sort_order=0, created_at=""))
    db.add(models.ExternalLink(name="Cubby", url="https://cubby.example.com", category="Day to Day",
                               department="Storage", departments=["Storage"]))
    db.add(models.ExternalLink(name="Gate Codes", url="https://gates.example.com", category="Day to Day",
                               department="storage", departments=["storage", "Accounting"]))
    db.add(models.ExternalLink(name="Both", url="https://both.example.com", category="Day to Day",
                               department="Operations", departments=["Operations", "Storage"]))
    db.add(models.ExternalLink(name="Outlook", url="https://outlook.example.com", category="Productivity",
                               department="", departments=[]))
    db.add(models.PersonalLink(owner_email="a@greensglobal.com", name="Mine", url="https://mine.example.com",
                               department="Storage"))
    db.add(models.LinkLayoutView(id="v1", owner_email="a@greensglobal.com", name="My view", is_default=True,
                                 layout={"folders": [], "items": [], "favorites": [],
                                         "filters": {"department": "Storage", "company": "", "category": ""}}))
    db.commit()


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(database.DATABASE_URL.startswith("sqlite"), "these tests drive the SQLite migration list")
        db = database.SessionLocal()
        try:
            _seed_storage_rows(db)
        finally:
            db.close()

    def _links(self, db):
        return {l.name: l for l in db.query(models.ExternalLink).all()}

    def test_storage_becomes_operations_everywhere_and_the_two_departments_arrive(self):
        main._run_migrations()
        db = database.SessionLocal()
        try:
            depts = {r.name for r in db.query(models.ExternalLinkTaxonomy).filter_by(kind="department").all()}
            # The Aug 14 seeds (Administration, Construction, IT) arrive with the same run.
            self.assertEqual(depts, {"Accounting", "Administration", "Construction", "Human Resources", "IT", "Marketing", "Operations"})
            links = self._links(db)
            self.assertEqual(links["Cubby"].departments, ["Operations"])
            self.assertEqual(links["Cubby"].department, "Operations")
            self.assertEqual(set(links["Gate Codes"].departments), {"Operations", "Accounting"})
            self.assertEqual(links["Gate Codes"].department, "Operations")
            self.assertEqual(links["Both"].departments, ["Operations"])      # the duplicate collapses
            self.assertEqual(links["Outlook"].departments, [])              # company-wide stays company-wide
            self.assertEqual(db.query(models.PersonalLink).one().department, "Operations")
            self.assertEqual(db.query(models.LinkLayoutView).one().layout["filters"]["department"], "Operations")
            # No link lost: every Storage link is an Operations link now (the
            # migration also seeds the Aug 2026 starter links, hence >=).
            self.assertEqual(set(links) & {"Cubby", "Gate Codes", "Both", "Outlook"}, {"Cubby", "Gate Codes", "Both", "Outlook"})
            self.assertFalse([l for l in links.values() if "Storage" in (l.departments or []) or l.department == "Storage"])
        finally:
            db.close()

    def test_running_the_migration_again_changes_nothing(self):
        main._run_migrations()
        main._run_migrations()
        db = database.SessionLocal()
        try:
            rows = db.query(models.ExternalLinkTaxonomy).filter_by(kind="department").all()
            names = sorted(r.name for r in rows)
            self.assertEqual(names, ["Accounting", "Administration", "Construction", "Human Resources", "IT", "Marketing", "Operations"])
            self.assertEqual(len(rows), 7)                                   # one row each, no re-seeded Storage
            self.assertEqual(self._links(db)["Gate Codes"].departments.count("Operations"), 1)
        finally:
            db.close()

    def test_a_database_that_already_had_operations_keeps_one_row(self):
        db = database.SessionLocal()
        try:
            db.add(models.ExternalLinkTaxonomy(id="dept-operations", kind="department", name="Operations", sort_order=9, created_at=""))
            db.commit()
        finally:
            db.close()
        main._run_migrations()
        db = database.SessionLocal()
        try:
            ops = db.query(models.ExternalLinkTaxonomy).filter_by(kind="department", name="Operations").all()
            self.assertEqual(len(ops), 1)
            self.assertFalse(db.query(models.ExternalLinkTaxonomy).filter_by(name="Storage").first())
        finally:
            db.close()


class ApiAliasTests(unittest.TestCase):
    def setUp(self):
        db = database.SessionLocal()
        try:
            _seed_storage_rows(db)
        finally:
            db.close()
        main._run_migrations()
        main.app.dependency_overrides[auth.get_current_user] = lambda: dict(ADMIN)
        self.c = TestClient(main.app)

    def tearDown(self):
        main.app.dependency_overrides.pop(auth.get_current_user, None)

    def test_helpers(self):
        self.assertEqual(el.canon_department(" storage "), "Operations")
        self.assertEqual(el.canon_department("STORAGE"), "Operations")
        self.assertEqual(el.canon_department("Marketing"), "Marketing")
        self.assertEqual(el.canon_department(""), "")
        self.assertEqual(el._clean_departments(["storage", "Operations", "operations", "", " IT "]), ["Operations", "IT"])

    def test_a_new_link_tagged_storage_is_filed_under_operations(self):
        r = self.c.post("/external-links", json={"name": "Keypad", "url": "https://keypad.example.com", "departments": ["Storage", "IT"]})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["departments"], ["Operations", "IT"])
        self.assertEqual(r.json()["department"], "Operations")
        link_id = r.json()["id"]
        r = self.c.patch(f"/external-links/{link_id}", json={"departments": ["storage"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["departments"], ["Operations"])

    def test_meta_and_taxonomy_never_say_storage(self):
        meta = self.c.get("/external-links/meta").json()
        self.assertIn("Operations", meta["departments"])
        self.assertNotIn("Storage", meta["departments"])
        tax = self.c.get("/external-links/taxonomy").json()
        names = [d["name"] for d in tax["departments"]]
        self.assertNotIn("Storage", names)
        for wanted in ("Human Resources", "Marketing", "Operations"):
            self.assertIn(wanted, names)

    def test_the_picker_refuses_storage_and_casing_twins(self):
        r = self.c.post("/external-links/taxonomy", json={"kind": "department", "name": "Storage"})
        self.assertEqual(r.status_code, 409, r.text)        # it is Operations, which exists
        r = self.c.post("/external-links/taxonomy", json={"kind": "department", "name": "operations"})
        self.assertEqual(r.status_code, 409, r.text)
        r = self.c.post("/external-links/taxonomy", json={"kind": "department", "name": "Legal"})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.c.patch(f"/external-links/taxonomy/{r.json()['id']}", json={"name": "storage"})
        self.assertEqual(r.status_code, 409, r.text)

    def test_a_personal_link_reads_operations(self):
        r = self.c.post("/personal-links", json={"name": "Mine 2", "url": "https://mine2.example.com", "department": "storage"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["department"], "Operations")


if __name__ == "__main__":
    unittest.main()
