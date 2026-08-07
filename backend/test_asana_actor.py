"""
Whose name a task field change appears under in Asana (Aug 2026).

Asana attributes the system stories a write produces ("X changed Priority to
Medium") to whoever owns the token, and offers no impersonation parameter. Every
task write used `cfg.token`, so every field change read as the shared sync
account no matter who made it - the actor was known in update_task and dropped
at the `_asana_push(task_id)` -> `on_task_changed(task_id)` boundary.

The actor is now threaded through to push_task, which picks its token with the
same `_actor_token` helper comments and attachments already use - one rule, so
the three cannot disagree about whose name a change carries.

The sweep deliberately passes NO actor. push_all re-derives what Asana should
have from the Nexus rows with nobody attached, and guessing one would credit the
wrong person whenever several people edited between sweeps: an honest service
account beats a confident wrong name.

Throwaway sqlite. No network - the Asana HTTP layer is stubbed and the tests
assert on which token reached it.

Run with: python -m unittest test_asana_actor -v
"""
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit

import asana_oauth
import asana_sync
import database
import models
import secret_box

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


ACTOR = "sagar.shoundik@greensglobal.com"
STRANGER = "nobody@greensglobal.com"
SERVICE_TOKEN = "service-pat"
USER_TOKEN = "sagars-own-token"


class ActorTokenTests(unittest.TestCase):
    """_actor_token is the single rule. push_comment, _push_attachments and now
    push_task all go through it."""

    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        self.db.query(models.AsanaUserToken).delete()
        self.db.commit()
        for key, val in (("ASANA_OAUTH_CLIENT_ID", "cid"),
                         ("ASANA_OAUTH_CLIENT_SECRET", "secret"),
                         ("NEXUS_API_BASE", "https://dev.example.com")):
            os.environ[key] = val
            self.addCleanup(os.environ.pop, key, None)

        class _Cfg:
            token = SERVICE_TOKEN
        self.cfg = _Cfg()

    def _grant(self, email=ACTOR):
        self.db.add(models.AsanaUserToken(
            id=str(uuid.uuid4()), email=email,
            access_token_enc=secret_box.encrypt(USER_TOKEN),
            refresh_token_enc=secret_box.encrypt("ref"),
            expires_at=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            created_at=""))
        self.db.commit()

    def test_a_connected_actor_writes_as_themselves(self):
        self._grant()
        token, is_user = asana_sync._actor_token(self.db, self.cfg, ACTOR)
        self.assertEqual(token, USER_TOKEN)
        self.assertTrue(is_user)

    def test_no_actor_falls_back_to_the_service_token(self):
        """The sweep's case - and the reason it is safe for the sweep to pass
        nothing rather than guess."""
        token, is_user = asana_sync._actor_token(self.db, self.cfg, "")
        self.assertEqual(token, SERVICE_TOKEN)
        self.assertFalse(is_user)

    def test_an_unconnected_actor_falls_back(self):
        token, is_user = asana_sync._actor_token(self.db, self.cfg, STRANGER)
        self.assertEqual(token, SERVICE_TOKEN)
        self.assertFalse(is_user)

    def test_the_asana_sync_stamp_is_not_a_person(self):
        """Rows that came FROM Asana carry this instead of an email - there is
        nobody behind it to attribute to."""
        token, is_user = asana_sync._actor_token(self.db, self.cfg, "asana-sync")
        self.assertEqual(token, SERVICE_TOKEN)
        self.assertFalse(is_user)


class PushTaskActorTests(unittest.TestCase):
    """Which token actually reaches Asana when a task is pushed."""

    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.Task, models.AsanaTaskLink, models.AsanaUserToken,
                  models.AsanaProjectMap, models.AsanaSyncConfig):
            self.db.query(m).delete()
        self.db.commit()
        for key, val in (("ASANA_OAUTH_CLIENT_ID", "cid"),
                         ("ASANA_OAUTH_CLIENT_SECRET", "secret"),
                         ("NEXUS_API_BASE", "https://dev.example.com")):
            os.environ[key] = val
            self.addCleanup(os.environ.pop, key, None)

        self.db.add(models.AsanaSyncConfig(id="singleton", token=SERVICE_TOKEN, enabled=True,
                                       workspace_gid="ws", default_project_gid="proj"))
        self.db.add(models.AsanaUserToken(
            id=str(uuid.uuid4()), email=ACTOR,
            access_token_enc=secret_box.encrypt(USER_TOKEN),
            refresh_token_enc=secret_box.encrypt("ref"),
            expires_at=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            created_at=""))
        self.task = models.Task(id=str(uuid.uuid4()), title="Fix the thing", code="TASK-1",
                                project_id="p", priority="medium",
                                created_at="", modified_at="")
        self.db.add(self.task)
        self.db.add(models.AsanaProjectMap(id=str(uuid.uuid4()), nexus_project_id="p",
                                           asana_project_gid="proj"))
        # Already linked, so the push takes the simple PUT path rather than the
        # advisory-locked create path.
        self.db.add(models.AsanaTaskLink(id=str(uuid.uuid4()), nexus_task_id=self.task.id,
                                         asana_gid="9001", last_hash="stale"))
        self.db.commit()

        # Capture the token every write is made with, instead of making one.
        self.used = []
        original = asana_sync._task_write

        def _spy(token, method, path, fields):
            self.used.append(token)
            return {"gid": "9001"}
        asana_sync._task_write = _spy
        self.addCleanup(setattr, asana_sync, "_task_write", original)

    def test_an_edit_pushes_under_the_person_who_made_it(self):
        """The bug this fixes: every field change read as the service account."""
        asana_sync.push_task(self.db, self.task, ACTOR)
        self.assertEqual(self.used, [USER_TOKEN])

    def test_the_sweep_pushes_as_the_service_account(self):
        """No actor is passed by push_all, and none is invented."""
        asana_sync.push_task(self.db, self.task)
        self.assertEqual(self.used, [SERVICE_TOKEN])

    def test_an_editor_who_never_connected_falls_back(self):
        asana_sync.push_task(self.db, self.task, STRANGER)
        self.assertEqual(self.used, [SERVICE_TOKEN])

    def test_a_broken_grant_falls_back_rather_than_dropping_the_edit(self):
        """Losing the change would be worse than posting it under the wrong
        name - the same rule the comment push follows."""
        row = asana_oauth.get_row(self.db, ACTOR)
        row.access_token_enc = "not-decryptable-under-this-key"
        row.refresh_token_enc = "also-not"
        self.db.commit()
        asana_sync.push_task(self.db, self.task, ACTOR)
        self.assertEqual(self.used, [SERVICE_TOKEN])


if __name__ == "__main__":
    unittest.main()


class TaskWriteDegradeTests(unittest.TestCase):
    """Asana rejects the whole request over one bad field, so a field it refuses
    must be dropped rather than take the rest of the task down with it."""

    def setUp(self):
        self.calls = []
        from asana_import import ImportError_
        self.ImportError_ = ImportError_

    def _send_that_rejects(self, needle):
        """Refuses the first attempt if it carries `needle`, accepts the retry."""
        def _send(token, path, body):
            fields = body["data"]
            self.calls.append(dict(fields))
            if needle in fields:
                raise self.ImportError_(
                    f'HTTP 400 PUT /tasks/1 - {{"errors":[{{"message":"assignee: '
                    f'Not a recognized ID"}}]}}')
            return {"gid": "1"}
        return _send

    def test_a_rejected_assignee_does_not_lose_the_rest_of_the_task(self):
        """The bug this fixes: one guest assignee who cannot reach the project
        stopped the task syncing at all - and read as 'assignee sync is broken'
        because the assignee was the visible half of what went missing."""
        original_put = asana_sync._asana_put
        asana_sync._asana_put = self._send_that_rejects("assignee")
        self.addCleanup(setattr, asana_sync, "_asana_put", original_put)

        out = asana_sync._task_write("tok", "PUT", "/tasks/1", {
            "name": "Fix the thing", "due_on": "2026-08-20", "assignee": "999"})

        self.assertEqual(out, {"gid": "1"})
        self.assertEqual(len(self.calls), 2, "should have retried once")
        self.assertIn("assignee", self.calls[0])
        self.assertNotIn("assignee", self.calls[1])
        # The point: the other fields still went.
        self.assertEqual(self.calls[1]["name"], "Fix the thing")
        self.assertEqual(self.calls[1]["due_on"], "2026-08-20")

    def test_an_unrelated_rejection_still_raises(self):
        """Degrading everything would hide real breakage."""
        def _send(token, path, body):
            raise self.ImportError_("HTTP 500 PUT /tasks/1 - server error")
        original_put = asana_sync._asana_put
        asana_sync._asana_put = _send
        self.addCleanup(setattr, asana_sync, "_asana_put", original_put)

        with self.assertRaises(self.ImportError_):
            asana_sync._task_write("tok", "PUT", "/tasks/1", {"name": "x"})
