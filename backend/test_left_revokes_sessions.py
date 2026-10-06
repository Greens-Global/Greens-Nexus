"""Left ends the leaver's sessions (gap G3 of the offboarding plan).

Blocking Entra sign-in only stops NEW sign-ins: Outlook and Teams on a phone,
and an open Nexus tab, kept working until their tokens expired. Now a change
to Left with a mailbox decision also calls Graph revokeSignInSessions, and
every Left drops the person's Nexus server sessions. A failed revoke is
reported and never skips the license step. Graph is replaced by recorders -
nothing leaves the machine.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_left_revokes_sessions.py -q
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import hr  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

HR = "hr.left.test@greensglobal.com"
LEAVER = "leaver.left.test@greensglobal.com"
OTHER = "stays.left.test@greensglobal.com"
GROUP = "grp-left-test"


class LeftRevokesSessions(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = HR
        db = database.SessionLocal()
        try:
            for m in (models.ServerSession, models.NexusGroupMember, models.NexusGroup):
                db.query(m).delete(synchronize_session=False)
            db.query(models.NexusEmployee).execution_options(include_deleted=True).delete(synchronize_session=False)
            db.add(models.NexusGroup(id=GROUP, name="Left Test HR", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=HR))
            db.add(models.NexusEmployee(id="emp-leaver", first_name="Lee", last_name="Ver", work_email=LEAVER,
                                        status="active", m365_id="m365-leaver", deleted_at=""))
            db.add(models.NexusEmployee(id="emp-nolink", first_name="No", last_name="Link",
                                        work_email="nolink.left.test@greensglobal.com", status="active", deleted_at=""))
            for sid, em in (("s1", LEAVER), ("s2", LEAVER), ("s3", OTHER), ("s4", "nolink.left.test@greensglobal.com")):
                db.add(models.ServerSession(id=sid, user_email=em))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        self.calls = []
        self._saved = (hr._graph_token, hr._graph_set_signin, hr._graph_revoke_sessions, hr._graph_remove_all_licenses)
        hr._graph_token = lambda: "tok"
        hr._graph_set_signin = lambda t, uid, en: self.calls.append(("signin", uid, en))
        hr._graph_revoke_sessions = lambda t, uid: self.calls.append(("revoke", uid))
        hr._graph_remove_all_licenses = lambda t, uid: (self.calls.append(("licenses", uid)), "1 released")[1]

    def tearDown(self):
        hr._graph_token, hr._graph_set_signin, hr._graph_revoke_sessions, hr._graph_remove_all_licenses = self._saved
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _sessions(self, email):
        db = database.SessionLocal()
        try:
            return db.query(models.ServerSession).filter(models.ServerSession.user_email == email).count()
        finally:
            db.close()

    def _leave(self, eid, **off):
        body = {"status": "offboarded", "reason": "Resigned", "offboarding": off or None}
        r = self.client.post(f"/hr/employees/{eid}/status", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_left_blocks_signin_ends_m365_and_nexus_sessions(self):
        out = self._leave("emp-leaver", mailboxAction="remove", freeUpLicense=True)
        self.assertIn(("signin", "m365-leaver", False), self.calls)
        self.assertIn(("revoke", "m365-leaver"), self.calls)
        self.assertEqual(out["m365"]["sessions"], "ended")
        self.assertEqual(out["m365"]["nexusSessions"], 2)
        self.assertEqual(self._sessions(LEAVER), 0)
        self.assertEqual(self._sessions(OTHER), 1)          # nobody else is logged out

    def test_failed_revoke_is_reported_and_licenses_still_go(self):
        def boom(t, uid):
            raise RuntimeError("Graph said no")
        hr._graph_revoke_sessions = boom
        out = self._leave("emp-leaver", mailboxAction="remove", freeUpLicense=True)
        self.assertIn("press Revoke Sessions in Entra", out["m365"]["sessions"])
        self.assertIn(("licenses", "m365-leaver"), self.calls)
        self.assertEqual(out["m365"]["licenses"], "1 released")

    def test_nexus_sessions_end_without_an_m365_link(self):
        out = self._leave("emp-nolink")
        self.assertEqual(out["m365"]["nexusSessions"], 1)
        self.assertEqual(self._sessions("nolink.left.test@greensglobal.com"), 0)

    def test_inactive_keeps_sessions(self):
        r = self.client.post("/hr/employees/emp-leaver/status",
                             json={"status": "inactive", "reason": "Leave", "offboarding": {"mailboxAction": "delegate", "delegateTo": [HR]}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._sessions(LEAVER), 2)
        self.assertNotIn(("revoke", "m365-leaver"), self.calls)


if __name__ == "__main__":
    unittest.main()
