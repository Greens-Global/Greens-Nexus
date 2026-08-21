"""Regression: one bad entry in a JSON email list must not 500 the module.

member_emails / follower_emails are user- and sync-supplied JSON. A single null
in ONE project's member list used to raise AttributeError ('NoneType' has no
attribute 'lower') inside visible_project_ids, which surfaced as a blanket 500
on /task-projects and /tasks/delta - but only for NON-managers, since managers
skip these helpers entirely. So the workspace looked healthy to an admin and
completely broken to everyone else, and one bad row took out the whole module.

    python -m unittest test_task_visibility_dirty_emails
"""
import os
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from models import Task, TaskProject, TaskTeam           # noqa: E402
from routers.task_util import (                          # noqa: E402
    email_list, task_is_visible, visible_project_ids,
)

ME = "someone@greensglobal.com"
# Everything a JSON column has actually been seen to hold, or could.
DIRTY = [None, ME, 42, "", {"email": ME}, ["nested"], True]


class _FakeQuery:
    def __init__(self, rows):
        self._rows = rows

    def filter(self, *_a, **_k):
        return self

    def all(self):
        return self._rows


class _FakeDb:
    """Just enough Session for visible_project_ids: query(Model).all()."""

    def __init__(self, projects=(), teams=(), tasks=()):
        self._by_model = {TaskProject: list(projects), TaskTeam: list(teams), Task: list(tasks)}

    def query(self, model):
        return _FakeQuery(self._by_model.get(model, []))


class TestEmailList(unittest.TestCase):
    def test_keeps_only_lowercased_strings(self):
        self.assertEqual(email_list(["A@B.com", None, 7, "c@d.com"]), ["a@b.com", "c@d.com"])

    def test_tolerates_none_and_non_lists(self):
        self.assertEqual(email_list(None), [])
        self.assertEqual(email_list([]), [])

    def test_drops_every_non_string_shape(self):
        self.assertEqual(email_list(DIRTY), [ME, ""])


class TestVisibleProjectIds(unittest.TestCase):
    def test_dirty_project_members_do_not_raise(self):
        p = TaskProject(id="p1", name="dirty", access_level="restricted", member_emails=DIRTY)
        ids = visible_project_ids(_FakeDb(projects=[p]), ME)
        self.assertEqual(ids, {"p1"}, "the real member in the list should still grant access")

    def test_dirty_team_members_do_not_raise(self):
        p = TaskProject(id="p2", name="x", access_level="restricted", member_emails=[])
        t = TaskTeam(id="t1", name="team", project_ids=["p2"], member_emails=[None, ME])
        ids = visible_project_ids(_FakeDb(projects=[p], teams=[t]), ME)
        self.assertEqual(ids, {"p2"})

    def test_one_bad_row_does_not_hide_the_good_ones(self):
        """The failure mode that made this a module-wide outage: the bad row
        aborted the whole scan, so every other project vanished too."""
        bad = TaskProject(id="bad", name="bad", access_level="restricted", member_emails=[None])
        good = TaskProject(id="good", name="good", access_level="org", member_emails=[])
        ids = visible_project_ids(_FakeDb(projects=[bad, good]), ME)
        self.assertIn("good", ids)

    def test_no_match_stays_no_match(self):
        p = TaskProject(id="p3", name="x", access_level="restricted", member_emails=[None, "other@x.com"])
        self.assertEqual(visible_project_ids(_FakeDb(projects=[p]), ME), set())


class TestTaskIsVisible(unittest.TestCase):
    def test_dirty_followers_do_not_raise(self):
        t = Task(id="t", title="x", access_level="restricted", follower_emails=DIRTY)
        self.assertTrue(task_is_visible(t, ME, set()), "the real follower should still see it")

    def test_dirty_followers_without_me_stay_hidden(self):
        t = Task(id="t", title="x", access_level="restricted", follower_emails=[None, 3])
        self.assertFalse(task_is_visible(t, ME, set()))


if __name__ == "__main__":
    unittest.main()
