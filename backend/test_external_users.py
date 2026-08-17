"""External users (Entra B2B guest allowlist) - the authorization boundary as
tests (Aug 17):

1. email_from_claims: employees resolve exactly as before; B2B-guest #EXT#
   UPNs resolve deterministically to the INVITED email.
2. Default-deny: a non-company email with no allowlist row is rejected even
   though its token/tenant would validate.
3. An ACTIVE enrolled guest can reach the app shell + granted modules only;
   inactive/expired guests are shut out; externals are hard-capped at employee
   and excluded from the people directory.
4. The admin CRUD enrolls/deactivates and manages the auto 'External - ' group.

Runs against the local SQLite DB like the other test_*.py files:
    python -m unittest test_external_users
"""
import os
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException
from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models

# A fresh checkout has no local SQLite yet (create_all normally runs in the
# app lifespan, which TestClient only triggers as a context manager).
models.Base.metadata.create_all(bind=database.engine)

GUEST = "jane.doe@acmeconstruction.com"
ADMIN = "authprobe.extadmin@greensglobal.com"


class TestEmailFromClaims(unittest.TestCase):
    def test_employee_unchanged(self):
        self.assertEqual(
            auth.email_from_claims({"preferred_username": "Visesh.Lodha@greensglobal.com"}),
            "visesh.lodha@greensglobal.com")

    def test_onmicrosoft_rewrite(self):
        self.assertEqual(
            auth.email_from_claims({"preferred_username": "neil@greensg.onmicrosoft.com"}),
            "neil@greensglobal.com")

    def test_guest_prefers_email_claim(self):
        claims = {"preferred_username": "jane.doe_acmeconstruction.com#EXT#@greensg.onmicrosoft.com",
                  "email": "Jane.Doe@acmeconstruction.com"}
        self.assertEqual(auth.email_from_claims(claims), GUEST)

    def test_guest_unmangles_ext_upn(self):
        claims = {"preferred_username": "jane.doe_acmeconstruction.com#EXT#@greensg.onmicrosoft.com"}
        self.assertEqual(auth.email_from_claims(claims), GUEST)

    def test_guest_underscore_in_localpart(self):
        claims = {"upn": "jane_doe_gmail.com#EXT#@greensg.onmicrosoft.com"}
        self.assertEqual(auth.email_from_claims(claims), "jane_doe@gmail.com")


class TestDefaultDeny(unittest.TestCase):
    """A non-company identity with NO allowlist row must be rejected - being a
    tenant guest alone never grants Nexus access."""

    def setUp(self):
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = False        # the SKIP_AUTH escape hatch is dev-only
        auth.invalidate_external_cache()

    def tearDown(self):
        auth.SKIP_AUTH = self._skip

    def test_unknown_external_email_403(self):
        with self.assertRaises(HTTPException) as ctx:
            auth.apply_external_policy(None, {"email": "stranger@gmail.com",
                                              "role": "employee", "level": 1})
        self.assertEqual(ctx.exception.status_code, 403)

    def test_internal_domain_passes_without_row(self):
        user = {"email": "someone.new@greensglobal.com", "role": "employee", "level": 1}
        self.assertEqual(auth.apply_external_policy(None, user), user)


class _ExternalBase(unittest.TestCase):
    """Shared setup: dev-identity path + guaranteed-clean guest/admin rows."""

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusEmployee).filter(
                models.NexusEmployee.work_email.in_([GUEST])).delete(synchronize_session=False)
            db.query(models.NexusRole).filter(
                models.NexusRole.email.in_([GUEST, ADMIN])).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(
                models.NexusGroupMember.email == GUEST).delete(synchronize_session=False)
            ext_ids = [g.id for g in db.query(models.NexusGroup)
                       .filter(models.NexusGroup.name.like("External - %")).all()]
            if ext_ids:
                db.query(models.NexusGroupMember).filter(
                    models.NexusGroupMember.group_id.in_(ext_ids)).delete(synchronize_session=False)
                db.query(models.NexusGroup).filter(
                    models.NexusGroup.id.in_(ext_ids)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache()
        auth.invalidate_external_cache()
        cache.module_grants.invalidate()
        cache.people_directory.invalidate()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _mk_guest(self, status="active", expires_at="", modules_csv=""):
        db = database.SessionLocal()
        try:
            db.add(models.NexusEmployee(
                id="ext-test-guest", first_name="Jane", last_name="Doe",
                work_email=GUEST, identity_type="guest", status=status,
                external_company="Acme Construction", invited_by=ADMIN,
                expires_at=expires_at, created_at="2026-08-17T00:00:00Z"))
            if modules_csv:
                db.add(models.NexusGroup(
                    id="EXTGRPTEST01", name="External - Test",
                    allowed_modules=modules_csv, created_by="test",
                    created_at="2026-08-17T00:00:00Z"))
                db.add(models.NexusGroupMember(
                    group_id="EXTGRPTEST01", email=GUEST,
                    added_by="test", added_at="2026-08-17T00:00:00Z"))
            db.commit()
        finally:
            db.close()
        auth.invalidate_external_cache(GUEST)
        cache.module_grants.invalidate(GUEST)


class TestGuestAccess(_ExternalBase):
    def test_active_guest_reaches_shell_only(self):
        self._mk_guest()
        self._as(GUEST)
        r = self.client.get("/roles/me")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["is_external"])
        self.assertEqual(r.json()["role"], "employee")
        # No module grant -> module APIs closed (both mapped and unmapped)
        self.assertEqual(self.client.get("/items").status_code, 403)
        self.assertEqual(self.client.get("/hr/employees").status_code, 403)

    def test_granted_module_opens_its_api_only(self):
        self._mk_guest(modules_csv="tasks:editor,tickets:editor")
        self._as(GUEST)
        self.assertEqual(self.client.get("/task-saved-views").status_code, 200)
        # Granted set never opens an unmapped internal module
        self.assertEqual(self.client.get("/items").status_code, 403)

    def test_inactive_guest_403(self):
        self._mk_guest(status="inactive")
        self._as(GUEST)
        self.assertEqual(self.client.get("/roles/me").status_code, 403)

    def test_expired_guest_403(self):
        self._mk_guest(expires_at="2026-01-01")
        self._as(GUEST)
        self.assertEqual(self.client.get("/roles/me").status_code, 403)

    def test_guest_capped_at_employee_even_with_role_row(self):
        self._mk_guest()
        db = database.SessionLocal()
        try:
            db.add(models.NexusRole(email=GUEST, role="manager", assigned_by="test"))
            db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache(GUEST)
        self._as(GUEST)
        r = self.client.get("/roles/me")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["role"], "employee")   # broadcast bell etc. stay closed

    def test_guest_sees_only_participating_tasks(self):
        """Org-default task visibility must NOT apply to externals: with a tasks
        grant they see tasks they participate in, never the whole company list."""
        self._mk_guest(modules_csv="tasks:editor,tickets:editor")
        db = database.SessionLocal()
        try:
            db.add(models.Task(id="ext-t-org", title="Company-internal task",
                               access_level="org", created_by="someone@greensglobal.com"))
            db.add(models.Task(id="ext-t-mine", title="Partner task",
                               access_level="org", assignee_email=GUEST,
                               created_by="someone@greensglobal.com"))
            db.commit()
        finally:
            db.close()
        try:
            self._as(GUEST)
            r = self.client.get("/tasks")
            self.assertEqual(r.status_code, 200, r.text)
            ids = {t["id"] for t in r.json()}
            self.assertIn("ext-t-mine", ids)
            self.assertNotIn("ext-t-org", ids)
            # An ordinary employee with the same grant still sees the org task
            # (the org default is narrowed for externals only, not for staff).
            emp = "plain.employee@greensglobal.com"
            db = database.SessionLocal()
            try:
                db.add(models.NexusGroupMember(group_id="EXTGRPTEST01", email=emp,
                                               added_by="test", added_at="2026-08-17T00:00:00Z"))
                db.commit()
            finally:
                db.close()
            cache.module_grants.invalidate()
            self._as(emp)
            ids = {t["id"] for t in self.client.get("/tasks").json()}
            self.assertIn("ext-t-org", ids)
        finally:
            db = database.SessionLocal()
            try:
                db.query(models.Task).filter(
                    models.Task.id.in_(("ext-t-org", "ext-t-mine"))).delete(synchronize_session=False)
                db.commit()
            finally:
                db.close()

    def test_guest_never_gets_ticket_desk_queue(self):
        """A tasks/tickets grant must not hand an external the whole agent queue."""
        self._mk_guest(modules_csv="tasks:editor,tickets:editor")
        db = database.SessionLocal()
        try:
            db.add(models.TaskTicket(id="ext-tk-other", code="900001", subject="Someone else's ticket",
                                     requester_email="someone@greensglobal.com", created_at="2026-08-17T00:00:00Z"))
            db.add(models.TaskTicket(id="ext-tk-mine", code="900002", subject="Partner ticket",
                                     requester_email=GUEST, created_at="2026-08-17T00:00:00Z"))
            db.commit()
        finally:
            db.close()
        try:
            self._as(GUEST)
            r = self.client.get("/task-tickets")
            self.assertEqual(r.status_code, 200, r.text)
            ids = {t["id"] for t in r.json()}
            self.assertIn("ext-tk-mine", ids)
            self.assertNotIn("ext-tk-other", ids)
        finally:
            db = database.SessionLocal()
            try:
                db.query(models.TaskTicket).filter(
                    models.TaskTicket.id.in_(("ext-tk-other", "ext-tk-mine"))).delete(synchronize_session=False)
                db.commit()
            finally:
                db.close()

    def test_guest_excluded_from_people_directory(self):
        self._mk_guest()
        self._as(GUEST)
        r = self.client.get("/myhr/directory")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn(GUEST, [p["email"] for p in r.json()])


class TestAdminCrud(_ExternalBase):
    def _as_admin(self):
        db = database.SessionLocal()
        try:
            db.add(models.NexusRole(email=ADMIN, role="administrator", assigned_by="test"))
            db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache(ADMIN)
        self._as(ADMIN)

    def test_enroll_grants_default_set_and_login_works(self):
        self._as_admin()
        r = self.client.post("/external-users", json={
            "email": GUEST, "first_name": "Jane", "last_name": "Doe",
            "company": "Acme Construction"})
        self.assertEqual(r.status_code, 201, r.text)
        mods = {m["id"]: m["level"] for m in r.json()["modules"]}
        self.assertEqual(mods, {"tasks": "editor", "tickets": "editor"})
        # The enrolled guest can now sign in and reach the granted family
        self._as(GUEST)
        self.assertEqual(self.client.get("/roles/me").status_code, 200)
        self.assertEqual(self.client.get("/task-saved-views").status_code, 200)

    def test_enroll_rejects_company_email_and_unsafe_module(self):
        self._as_admin()
        r = self.client.post("/external-users", json={
            "email": "someone@greensglobal.com", "first_name": "X"})
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/external-users", json={
            "email": GUEST, "first_name": "Jane",
            "modules": [{"id": "hr", "level": "viewer"}]})
        self.assertEqual(r.status_code, 400)

    def test_deactivate_shuts_the_door(self):
        self._as_admin()
        self.client.post("/external-users", json={"email": GUEST, "first_name": "Jane"})
        r = self.client.patch(f"/external-users/{GUEST}", json={"status": "inactive"})
        self.assertEqual(r.status_code, 200, r.text)
        self._as(GUEST)
        self.assertEqual(self.client.get("/roles/me").status_code, 403)

    def test_non_admin_cannot_manage(self):
        self._as("plain.employee@greensglobal.com")
        self.assertIn(self.client.get("/external-users").status_code, (401, 403))


if __name__ == "__main__":
    unittest.main()
