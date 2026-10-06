"""Investor Relations read gate (require_ir_view) - Sep 30 review.

Every GP-side GET (funds, investors, commitments, capital calls, distributions,
capital accounts, documents, updates) used to admit any supervisor, with no
grant. It now admits who can open the screen: administrator+, or a supervisor+
holding an Access Group grant on "investor-relations". Portal investors carry
the same viewer grant through the "Investor" group, but are external accounts
(always level 1), so they stay out.

Run with: python -m pytest test_ir_view_access.py
"""
import os
import tempfile
import unittest
import uuid

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException
from fastapi.routing import APIRoute

import database
import models
from routers import investor_relations as IR

SUPERVISOR = {"email": "sam@greensglobal.com", "level": 2}
MANAGER = {"email": "maya@greensglobal.com", "level": 3}
GRANTED_SUP = {"email": "gina@greensglobal.com", "level": 2}
GRANTED_EMP = {"email": "eli@greensglobal.com", "level": 1}
ADMIN = {"email": "ada@greensglobal.com", "level": 4}
PORTAL = {"email": "investor@example.com", "level": 1, "external": True}


class IrViewGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        db = database.SessionLocal()
        try:
            gid, pid = str(uuid.uuid4()), str(uuid.uuid4())
            db.add(models.NexusGroup(id=gid, name="IR Team", allowed_modules="investor-relations:viewer"))
            db.add(models.NexusGroup(id=pid, name="Investor", allowed_modules="investor-relations:viewer"))
            for email in (GRANTED_SUP["email"], GRANTED_EMP["email"]):
                db.add(models.NexusGroupMember(group_id=gid, email=email))
            db.add(models.NexusGroupMember(group_id=pid, email=PORTAL["email"]))
            db.commit()
        finally:
            db.close()

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except FileNotFoundError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()

    def tearDown(self):
        self.db.close()

    def _admitted(self, user):
        try:
            IR.require_ir_view(user=user, db=self.db)
            return True
        except HTTPException as e:
            self.assertEqual(e.status_code, 403)
            return False

    def test_a_supervisor_or_manager_without_the_grant_is_refused(self):
        self.assertFalse(self._admitted(SUPERVISOR))
        self.assertFalse(self._admitted(MANAGER))

    def test_a_supervisor_with_the_grant_is_admitted(self):
        self.assertTrue(self._admitted(GRANTED_SUP))

    def test_an_administrator_is_admitted_without_a_grant(self):
        self.assertTrue(self._admitted(ADMIN))

    def test_a_portal_investor_never_reaches_the_gp_side(self):
        self.assertFalse(self._admitted(PORTAL))

    def test_the_supervisor_floor_stays(self):
        # Unchanged from before: below supervisor, a grant alone does not open
        # the GP side - that floor is what separates staff from portal accounts.
        self.assertFalse(self._admitted(GRANTED_EMP))

    def test_every_gp_side_get_uses_the_gate(self):
        ungated = []
        for r in IR.router.routes:
            if not isinstance(r, APIRoute) or "GET" not in r.methods or "/portal/" in r.path:
                continue
            calls = {d.call for d in r.dependant.dependencies}
            if not calls & {IR.require_ir_view, IR.require_ir_edit, IR.require_ir_admin}:
                ungated.append(r.path)
        self.assertEqual(ungated, [])


if __name__ == "__main__":
    unittest.main()
