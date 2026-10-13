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

    def test_bulk_sets_a_custom_field_without_touching_the_others(self):
        # Batch-setting Property (Oct 13 2026) merges into each task's values.
        db = database.SessionLocal()
        try:
            for fid, kind, opts in (("bulk-prop", "select", [{"id": "esc", "label": "GS Escondido"}]),
                                    ("bulk-pts", "number", [])):
                if not db.get(models.TaskCustomField, fid):
                    db.add(models.TaskCustomField(id=fid, name=fid, type=kind, options=opts))
            db.commit()
        finally:
            db.close()
        a = make(title="Prop A", custom_field_values={"bulk-pts": 5})
        b = make(title="Prop B")
        r = c.post("/tasks/bulk", json={"ids": [a["id"], b["id"]],
                                        "patch": {"custom_field_values": {"bulk-prop": "esc"}}})
        self.assertEqual(r.status_code, 200, r.text)
        got = {t["id"]: t["customFieldValues"] for t in r.json()}
        self.assertEqual(got[a["id"]], {"bulk-pts": 5, "bulk-prop": "esc"})
        self.assertEqual(got[b["id"]], {"bulk-prop": "esc"})
        # A blank clears that one field.
        r = c.post("/tasks/bulk", json={"ids": [a["id"]], "patch": {"custom_field_values": {"bulk-prop": ""}}})
        self.assertEqual(r.json()[0]["customFieldValues"], {"bulk-pts": 5})


    def test_a_project_s_required_field_must_be_filled_to_create_a_task(self):
        # Required per project (Oct 13 2026): enforced by the API, so no
        # create path - quick-add row, request form - can skip it.
        db = database.SessionLocal()
        try:
            if not db.get(models.TaskProject, "req-proj"):
                db.add(models.TaskProject(id="req-proj", name="IT Support", owner_email=ME))
            if not db.get(models.TaskCustomField, "req-prop"):
                db.add(models.TaskCustomField(id="req-prop", name="Property", type="select",
                                              options=[{"id": "esc", "label": "GS Escondido"}],
                                              project_ids=["req-proj"], required_project_ids=["req-proj"]))
            db.commit()
        finally:
            db.close()
        r = c.post("/tasks", json={"title": "No property", "project_id": "req-proj"})
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn("Property is required for tasks in IT Support", r.text)
        r = c.post("/tasks", json={"title": "With property", "project_id": "req-proj",
                                   "custom_field_values": {"req-prop": "esc"}})
        self.assertIn(r.status_code, (200, 201), r.text)
        # A subtask is part of its parent; a task outside the project is untouched.
        sub = c.post("/tasks", json={"title": "Sub", "project_id": "req-proj", "parent_task_id": r.json()["id"]})
        self.assertIn(sub.status_code, (200, 201), sub.text)
        self.assertIn(c.post("/tasks", json={"title": "Elsewhere"}).status_code, (200, 201))


    def test_a_main_task_remembers_its_subtasks_were_hand_ordered(self):
        # Oct 13 2026: "" = due date then priority, "manual" = dragged order.
        t = make(title="Ordered")
        self.assertEqual(t["subtaskOrder"], "")
        self.assertEqual(patch(t["id"], subtask_order="manual")["subtaskOrder"], "manual")
        self.assertEqual(patch(t["id"], subtask_order="sideways")["subtaskOrder"], "")
        sub = make(title="Sub", parent_task_id=t["id"])
        self.assertEqual(patch(sub["id"], position=1)["position"], 1)


    def test_a_project_s_time_tracking_setting(self):
        # Oct 13 2026: "" automatic, "on", "off"; anything else reads as automatic.
        r = c.post("/task-projects", json={"name": "Timed", "time_tracking": "on"})
        self.assertIn(r.status_code, (200, 201), r.text)
        p = r.json()
        self.assertEqual(p["timeTracking"], "on")
        r = c.patch(f"/task-projects/{p['id']}", json={"time_tracking": "off"})
        self.assertEqual(r.json()["timeTracking"], "off")
        r = c.patch(f"/task-projects/{p['id']}", json={"time_tracking": "maybe"})
        self.assertEqual(r.json()["timeTracking"], "")


    def test_custom_sections_file_tasks_and_a_project_move_unfiles_them(self):
        # The Custom grouping (Oct 13 2026).
        proj = c.post("/task-projects", json={"name": "Sectioned"}).json()
        sec = c.post("/tasks/meta/sections", json={"project_id": proj["id"], "name": "Annual Recurring"})
        self.assertIn(sec.status_code, (200, 201), sec.text)
        sid = sec.json()["id"]
        a = make(title="Inspection", project_id=proj["id"])
        b = make(title="Fire panel", project_id=proj["id"])
        r = c.post("/tasks/bulk", json={"ids": [a["id"], b["id"]], "patch": {"section_id": sid}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual({t["sectionId"] for t in r.json()}, {sid})
        # Moved to another project: the section stays behind with its project.
        other = c.post("/task-projects", json={"name": "Elsewhere"}).json()
        self.assertFalse(patch(a["id"], project_id=other["id"])["sectionId"])   # null / "" = no section
        # A change that is not a project move leaves it filed.
        self.assertEqual(patch(b["id"], title="Fire panel test")["sectionId"], sid)


if __name__ == "__main__":
    unittest.main(verbosity=2)
