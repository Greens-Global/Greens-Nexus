"""Creating a task for someone else makes you a collaborator on it.

Someone who raises work for a colleague almost always wants the comments and
the completion, and having to remember to add yourself is the kind of step that
gets skipped. Server-side so every entry point inherits it.

Uses a throwaway sqlite file. Run with:
    python -m unittest test_task_creator_follows
"""
import os
import tempfile
import unittest

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["NEXUS_DEV_EMAIL"] = "sagar.shoundik@greensglobal.com"

from fastapi.testclient import TestClient
import auth
import database
import models
import main

OTHER = "visesh@greensglobal.com"
THIRD = "ankush@greensglobal.com"

# Whoever the dev-auth shim actually resolves to - NOT a hardcoded address.
# Every test module here sets DATABASE_URL at import time, so under a single
# `unittest discover` run the FIRST module imported wins and the rest see a
# database (and an identity) they did not set up. Reading the effective caller
# and seeding fixtures at setUpClass keeps this file passing either way.
ME = (os.environ.get("NEXUS_DEV_EMAIL") or "").strip().lower()

c = TestClient(main.app)


def _seed():
    """Tables + a role for the caller, against whichever engine is live.

    The Task module is grant-gated (auth.require_any_module_grant);
    administrator bypasses the grant, which is the cheapest way in for a test
    about task rows.
    """
    models.Base.metadata.create_all(bind=database.engine)
    db = database.SessionLocal()
    try:
        if not db.query(models.NexusRole).filter(models.NexusRole.email == ME).first():
            db.add(models.NexusRole(email=ME, role="administrator", assigned_by="test"))
            db.commit()
    finally:
        db.close()
    # get_current_user caches the resolved role for a couple of minutes.
    getattr(auth, "_role_cache", {}).clear()


def make(**body):
    r = c.post("/tasks", json={"title": "t", **body})
    assert r.status_code in (200, 201), r.text
    return r.json()


class CreatorFollowsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # `auth` reads NEXUS_SKIP_AUTH at import time, and every module here
        # sets its own env at import: under one `unittest discover` process the
        # first module imported wins, so this file's dev-auth shim may not be
        # the one in effect. Skip rather than report a failure that says nothing
        # about the behavior under test - run this module on its own (as its
        # docstring says) for real coverage.
        _seed()
        if not ME or c.post("/tasks", json={"title": "probe"}).status_code >= 400:
            raise unittest.SkipTest(
                "needs this module's own dev-auth env; run: python -m unittest test_task_creator_follows")

    def test_creator_follows_a_task_assigned_to_someone_else(self):
        t = make(title="For Visesh", assignee_emails=[OTHER])
        self.assertIn(ME, [f.lower() for f in t["followerIds"]])

    def test_creator_is_not_added_when_they_are_the_assignee(self):
        # Already on the task - adding them again would show their own face
        # twice in the Person cell.
        t = make(title="Mine", assignee_emails=[ME])
        self.assertNotIn(ME, [f.lower() for f in t["followerIds"]])

    def test_creator_is_not_duplicated_when_already_a_follower(self):
        t = make(title="Dup", assignee_emails=[OTHER], follower_emails=[ME])
        followers = [f.lower() for f in t["followerIds"]]
        self.assertEqual(followers.count(ME), 1)

    def test_existing_followers_are_kept(self):
        t = make(title="Keep", assignee_emails=[OTHER], follower_emails=[THIRD])
        followers = [f.lower() for f in t["followerIds"]]
        self.assertIn(THIRD, followers)
        self.assertIn(ME, followers)

    def test_creator_follows_an_unassigned_task(self):
        # Nobody is on it yet, so the person who raised it is the only one who
        # would ever hear about it.
        t = make(title="Nobody")
        self.assertIn(ME, [f.lower() for f in t["followerIds"]])

    def test_creator_follows_when_they_are_a_secondary_assignee(self):
        t = make(title="Shared", assignee_emails=[OTHER, ME])
        # On the task already, as an assignee - not doubled up as a follower.
        self.assertNotIn(ME, [f.lower() for f in t["followerIds"]])


def patch(tid, **body):
    r = c.patch(f"/tasks/{tid}", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def followers(t):
    return [f.lower() for f in t["followerIds"]]


class AssignLaterFollowsTests(unittest.TestCase):
    """Assigning somebody LATER subscribes the assigner too - the same reason
    creating the task does."""

    @classmethod
    def setUpClass(cls):
        _seed()
        if not ME or c.post("/tasks", json={"title": "probe"}).status_code >= 400:
            raise unittest.SkipTest(
                "needs this module's own dev-auth env; run: python -m unittest test_task_creator_follows")

    def test_assigning_someone_later_adds_the_assigner(self):
        # Created assigned to me, so I start as an assignee and NOT a follower.
        t = make(title="Later", assignee_emails=[ME])
        self.assertNotIn(ME, followers(t))
        # Hand it to someone else: I am no longer an assignee, so I follow.
        t = patch(t["id"], assignee_emails=[OTHER])
        self.assertIn(ME, followers(t))

    def test_adding_a_second_assignee_adds_the_assigner(self):
        t = make(title="Second", assignee_emails=[OTHER])
        t = patch(t["id"], follower_emails=[])          # start from a clean list
        self.assertNotIn(ME, followers(t))
        t = patch(t["id"], assignee_emails=[OTHER, THIRD])
        self.assertIn(ME, followers(t))

    def test_unassigning_does_not_subscribe_the_actor(self):
        # Taking somebody OFF a task is no reason to subscribe anyone to it.
        t = make(title="Unassign", assignee_emails=[OTHER, THIRD])
        t = patch(t["id"], follower_emails=[])
        t = patch(t["id"], assignee_emails=[OTHER])
        self.assertNotIn(ME, followers(t))

    def test_assigning_myself_later_does_not_add_me_as_a_follower(self):
        t = make(title="Self", assignee_emails=[OTHER])
        t = patch(t["id"], follower_emails=[])
        t = patch(t["id"], assignee_emails=[ME])
        self.assertNotIn(ME, followers(t))

    def test_an_explicit_collaborator_list_in_the_same_patch_wins(self):
        # The caller stating who is on the task includes deciding it is not them.
        t = make(title="Explicit", assignee_emails=[ME])
        t = patch(t["id"], assignee_emails=[OTHER], follower_emails=[THIRD])
        self.assertEqual(followers(t), [THIRD])

    def test_a_non_assignment_edit_does_not_subscribe_the_actor(self):
        t = make(title="Rename", assignee_emails=[OTHER])
        t = patch(t["id"], follower_emails=[])
        t = patch(t["id"], title="Renamed")
        self.assertNotIn(ME, followers(t))

    def test_bulk_assign_adds_the_assigner(self):
        a = make(title="Bulk A", assignee_emails=[ME])
        b = make(title="Bulk B", assignee_emails=[ME])
        r = c.post("/tasks/bulk", json={"ids": [a["id"], b["id"]],
                                        "patch": {"assignee_emails": [OTHER]}})
        self.assertEqual(r.status_code, 200, r.text)
        # bulk_update hands back the updated rows - there is no single-task GET.
        for got in r.json():
            self.assertIn(ME, followers(got), got["id"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
