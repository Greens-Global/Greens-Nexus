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
from unittest import mock

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException
from fastapi.testclient import TestClient

import auth
import cache
import database
import graph_mail
import main
import models
import routers.external_users as ext_router

# Belt and suspenders: even if this machine's environment carries real Azure
# credentials, tests must NEVER talk to Microsoft Graph. Blanking the module
# globals makes graph_configured() False; the invite tests stub the HTTP layer.
graph_mail._AZURE_TENANT_ID = ""
graph_mail._AZURE_CLIENT_ID = ""
graph_mail._AZURE_CLIENT_SECRET = ""

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

    def _as_admin(self):
        db = database.SessionLocal()
        try:
            if not db.query(models.NexusRole).filter(models.NexusRole.email == ADMIN).first():
                db.add(models.NexusRole(email=ADMIN, role="administrator", assigned_by="test"))
                db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache(ADMIN)
        self._as(ADMIN)

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
    def test_enroll_gives_no_access_until_granted_normally(self):
        """Aug 18 rework: enrolling grants NOTHING - access flows through the
        normal Roles & Access machinery (groups/job roles) like any employee.
        A fresh guest reaches only the app shell (fail-closed)."""
        self._as_admin()
        r = self.client.post("/external-users", json={
            "email": GUEST, "first_name": "Jane", "last_name": "Doe",
            "company": "Acme Construction"})
        self.assertEqual(r.status_code, 201, r.text)
        self._as(GUEST)
        self.assertEqual(self.client.get("/roles/me").status_code, 200)   # shell works
        self.assertEqual(self.client.get("/task-saved-views").status_code, 403)  # nothing granted
        # A NORMAL group grant (same machinery as employees) opens the module
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id="EXTGRPTEST02", name="Partner Collab",
                                     allowed_modules="tasks:editor", created_by="test",
                                     created_at="2026-08-18T00:00:00Z"))
            db.add(models.NexusGroupMember(group_id="EXTGRPTEST02", email=GUEST,
                                           added_by="test", added_at="2026-08-18T00:00:00Z"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate(GUEST)
        try:
            self.assertEqual(self.client.get("/task-saved-views").status_code, 200)
        finally:
            db = database.SessionLocal()
            try:
                db.query(models.NexusGroupMember).filter(
                    models.NexusGroupMember.group_id == "EXTGRPTEST02").delete(synchronize_session=False)
                db.query(models.NexusGroup).filter(
                    models.NexusGroup.id == "EXTGRPTEST02").delete(synchronize_session=False)
                db.commit()
            finally:
                db.close()

    def test_any_module_grant_opens_its_api(self):
        """No more fixed external-safe set: ANY module is grantable through
        groups, and the grant opens that module's API surface for the guest."""
        self._mk_guest(modules_csv="inventory:viewer")
        self._as(GUEST)
        self.assertEqual(self.client.get("/items").status_code, 200)
        # Still fail-closed for surfaces no grant covers
        self.assertEqual(self.client.get("/hr/employees").status_code, 403)

    def test_enroll_rejects_company_email(self):
        self._as_admin()
        r = self.client.post("/external-users", json={
            "email": "someone@greensglobal.com", "first_name": "X"})
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


class TestRemove(_ExternalBase):
    """Permanent Remove (Visesh, Aug 18): erases the guest from Nexus entirely,
    unlike the reversible Deactivate. Guest/external rows only."""

    def test_remove_deletes_row_memberships_and_locks_out(self):
        self._as_admin()
        self.client.post("/external-users", json={"email": GUEST, "first_name": "Jane"})
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id="EXTGRPTEST03", name="Partner Collab Rm",
                                     allowed_modules="tasks:editor", created_by="test",
                                     created_at="2026-08-18T00:00:00Z"))
            db.add(models.NexusGroupMember(group_id="EXTGRPTEST03", email=GUEST,
                                           added_by="test", added_at="2026-08-18T00:00:00Z"))
            db.add(models.NexusRole(email=GUEST, role="employee", assigned_by="test"))
            db.commit()
        finally:
            db.close()
        try:
            r = self.client.delete(f"/external-users/{GUEST}")
            self.assertEqual(r.status_code, 200, r.text)
            db = database.SessionLocal()
            try:
                self.assertIsNone(db.query(models.NexusEmployee).filter(
                    models.NexusEmployee.work_email == GUEST).first())
                self.assertEqual(db.query(models.NexusGroupMember).filter(
                    models.NexusGroupMember.email == GUEST).count(), 0)
                self.assertEqual(db.query(models.NexusRole).filter(
                    models.NexusRole.email == GUEST).count(), 0)
            finally:
                db.close()
            # Removed = default-denied at sign-in again (no allowlist row).
            # Checked at the policy level with the dev bypass off - the HTTP
            # path under NEXUS_SKIP_AUTH deliberately skips the unknown-email
            # deny so local development works.
            auth.SKIP_AUTH = False
            try:
                with self.assertRaises(HTTPException) as ctx:
                    auth.apply_external_policy(None, {"email": GUEST, "role": "employee", "level": 1})
                self.assertEqual(ctx.exception.status_code, 403)
            finally:
                auth.SKIP_AUTH = True
            # And a second remove is a clean 404, not a 500
            self._as_admin()
            self.assertEqual(self.client.delete(f"/external-users/{GUEST}").status_code, 404)
        finally:
            db = database.SessionLocal()
            try:
                db.query(models.NexusGroupMember).filter(
                    models.NexusGroupMember.group_id == "EXTGRPTEST03").delete(synchronize_session=False)
                db.query(models.NexusGroup).filter(
                    models.NexusGroup.id == "EXTGRPTEST03").delete(synchronize_session=False)
                db.commit()
            finally:
                db.close()

    def test_remove_never_touches_employees(self):
        self._as_admin()
        db = database.SessionLocal()
        try:
            db.add(models.NexusEmployee(
                id="ext-test-internal", first_name="Real", last_name="Employee",
                work_email="real.employee@greensglobal.com", identity_type="internal",
                status="active", created_at="2026-08-18T00:00:00Z"))
            db.commit()
        finally:
            db.close()
        try:
            r = self.client.delete("/external-users/real.employee@greensglobal.com")
            self.assertEqual(r.status_code, 404)   # not an external row -> untouchable here
            db = database.SessionLocal()
            try:
                self.assertIsNotNone(db.query(models.NexusEmployee).filter(
                    models.NexusEmployee.id == "ext-test-internal").first())
            finally:
                db.close()
        finally:
            db = database.SessionLocal()
            try:
                db.query(models.NexusEmployee).filter(
                    models.NexusEmployee.id == "ext-test-internal").delete(synchronize_session=False)
                db.commit()
            finally:
                db.close()

    def test_task_assigned_to_removed_external_still_displays(self):
        """The removed email's historical footprint stays: a task assigned to
        them must still list without a 500, name resolution falling back to the
        email (externals were never in the directory to begin with)."""
        self._as_admin()
        self.client.post("/external-users", json={"email": GUEST, "first_name": "Jane"})
        db = database.SessionLocal()
        try:
            db.add(models.Task(id="ext-t-removed", title="Left-behind task",
                               access_level="org", assignee_email=GUEST,
                               created_by="someone@greensglobal.com"))
            db.commit()
        finally:
            db.close()
        try:
            self.assertEqual(self.client.delete(f"/external-users/{GUEST}").status_code, 200)
            r = self.client.get("/tasks")   # admin sees all tasks
            self.assertEqual(r.status_code, 200, r.text)
            row = next(t for t in r.json() if t["id"] == "ext-t-removed")
            self.assertEqual(row["assigneeId"], GUEST)
            # Directory read (name-resolution source) also stays healthy
            self.assertEqual(self.client.get("/myhr/directory").status_code, 200)
        finally:
            db = database.SessionLocal()
            try:
                db.query(models.Task).filter(
                    models.Task.id == "ext-t-removed").delete(synchronize_session=False)
                db.commit()
            finally:
                db.close()

    def test_remove_requires_admin(self):
        self._mk_guest()
        self._as("plain.employee@greensglobal.com")
        self.assertIn(self.client.delete(f"/external-users/{GUEST}").status_code, (401, 403))


class _FakeResp:
    def __init__(self, status_code, body=None, text=""):
        self.status_code = status_code
        self._body = body if body is not None else {}
        self.text = text

    def json(self):
        return self._body


class TestInviteFlow(_ExternalBase):
    """The invite-from-Nexus path (Graph POST /invitations) with the HTTP layer
    stubbed - success, 403 degradation, and the already-exists conflict. No
    test ever reaches the real Microsoft Graph."""

    def _enroll(self):
        return self.client.post("/external-users", json={
            "email": GUEST, "first_name": "Jane", "last_name": "Doe",
            "company": "Acme Construction"})

    def _with_graph(self, fake_post):
        return (mock.patch.object(graph_mail, "graph_configured", return_value=True),
                mock.patch.object(graph_mail, "access_token", return_value="fake-token"),
                mock.patch.object(ext_router.httpx, "post", side_effect=fake_post))

    def test_enroll_sends_invitation(self):
        self._as_admin()
        calls = []

        def fake_post(url, headers=None, json=None, timeout=None):
            calls.append((url, headers, json))
            return _FakeResp(201, {"id": "inv-1", "status": "PendingAcceptance"})

        p1, p2, p3 = self._with_graph(fake_post)
        with p1, p2, p3:
            r = self._enroll()
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["inviteStatus"], "sent")
        self.assertIn("sent", r.json()["inviteMessage"].lower())
        url, headers, payload = calls[0]
        self.assertEqual(url, "https://graph.microsoft.com/v1.0/invitations")
        self.assertEqual(headers["Authorization"], "Bearer fake-token")
        self.assertEqual(payload["invitedUserEmailAddress"], GUEST)
        self.assertEqual(payload["invitedUserDisplayName"], "Jane Doe")
        self.assertTrue(payload["sendInvitationMessage"])
        self.assertTrue(payload["inviteRedirectUrl"].startswith("http"))
        self.assertIn("Nexus", payload["invitedUserMessageInfo"]["customizedMessageBody"])
        # Stored on the row too
        listed = self.client.get("/external-users").json()
        self.assertEqual(listed[0]["inviteStatus"], "sent")

    def test_missing_consent_degrades_but_still_enrolls(self):
        self._as_admin()
        p1, p2, p3 = self._with_graph(lambda *a, **k: _FakeResp(
            403, {"error": {"code": "Authorization_RequestDenied",
                            "message": "Insufficient privileges to complete the operation."}}))
        with p1, p2, p3:
            r = self._enroll()
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["inviteStatus"], "failed")
        self.assertIn("User.Invite.All", r.json()["inviteMessage"])
        # The allowlist row exists and the guest can sign in regardless
        self._as(GUEST)
        self.assertEqual(self.client.get("/roles/me").status_code, 200)

    def test_graph_unconfigured_degrades(self):
        # No patches: graph_configured() is False in tests - no HTTP happens.
        self._as_admin()
        r = self._enroll()
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["inviteStatus"], "failed")
        self.assertIn("not configured", r.json()["inviteMessage"])

    def test_conflict_marks_manual(self):
        self._as_admin()
        p1, p2, p3 = self._with_graph(lambda *a, **k: _FakeResp(
            409, {"error": {"message": "A user with this email already exists in the directory."}}))
        with p1, p2, p3:
            r = self._enroll()
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["inviteStatus"], "manual")

    def test_resend_invite_updates_status(self):
        self._as_admin()
        r = self._enroll()                       # unconfigured -> 'failed'
        self.assertEqual(r.json()["inviteStatus"], "failed")
        p1, p2, p3 = self._with_graph(lambda *a, **k: _FakeResp(201, {"id": "inv-2"}))
        with p1, p2, p3:
            r = self.client.post(f"/external-users/{GUEST}/invite")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["inviteStatus"], "sent")
        self.assertEqual(self.client.get("/external-users").json()[0]["inviteStatus"], "sent")

    def test_resend_unknown_email_404(self):
        self._as_admin()
        self.assertEqual(self.client.post("/external-users/nobody@nowhere.com/invite").status_code, 404)


if __name__ == "__main__":
    unittest.main()
