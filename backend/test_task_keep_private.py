"""Keep Private (Oct 23 2026, Neil: "yes keep the option").

A subtask private only because of its parent (narrowed_by == parent,
task_util.inherits_privacy) opens to everyone again when that parent is
shared again (tasks._cascade_level). Keep Private turns it into a subtask
private BY HAND - the marker cleared, the level kept - so:

- POST /tasks/{id}/keep-private: editor on the subtask (the bar for changing
  its level); the parent's people lose the sight the marker gave them; the
  person keeping it never does (added as a collaborator when they would
  lose it; a manager never is); a reopen of the parent leaves it private;
- an outsider and a guest who only follows the parent are refused (404);
  a guest ON the subtask may keep it and is never added (they keep their own
  sight); an org-wide subtask is refused (422); one private by hand already
  is answered unchanged;
- opening the parent with keep_subtasks_private keeps every row that would
  have come back private by hand (one activity row, the reopener added where
  they would lose sight), the rows below them still following them; the flag
  on any other edit changes nothing.

Throwaway SQLite, no network.  python -m pytest test_task_keep_private.py
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException  # noqa: E402

import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from routers import tasks as T  # noqa: E402
from routers.task_util import gen_id, now_iso, task_visible_to  # noqa: E402


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

OWNER = {"email": "owner@greensglobal.com", "level": 1}
HELPER = {"email": "helper@greensglobal.com", "level": 1}     # an assignee of the parent
OTHER = {"email": "other@greensglobal.com", "level": 1}       # owns a subtask
OUTSIDER = {"email": "outsider@greensglobal.com", "level": 1}
MEMBER = {"email": "member@greensglobal.com", "level": 1}     # on the restricted project
OTHERCO = {"email": "b@greensglobal.com", "level": 3}         # a manager in another company
EXT = {"email": "guest@vendor.com", "level": 1, "external": True}
COA, COB = "co-a", "co-b"
TODAY = "2026-10-22"


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except FileNotFoundError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskProject, models.TaskActivity, models.TaskNotification,
                  models.NexusNotification, models.NexusEmployee, models.NexusSetting, models.TaskTablePref,
                  models.TaskChecklistItem):
            self.db.query(m).execution_options(include_deleted=True).delete()
        for u, co in ((OWNER, COA), (HELPER, COA), (OTHER, COA), (OUTSIDER, COA), (MEMBER, COA), (OTHERCO, COB)):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=u["email"], status="active",
                                             first_name=u["email"].split("@")[0], company=co))
        self.db.commit()
        cache.settings_config.invalidate()
        self.bg = BackgroundTasks()

    def tearDown(self):
        self.db.close()
        cache.settings_config.invalidate()

    def task(self, **kw):
        kw.setdefault("project_id", "")
        kw.setdefault("company_id", COA)
        kw.setdefault("status", "not_started")
        kw.setdefault("created_by", kw.get("owner_email") or OWNER["email"])
        t = models.Task(id=gen_id(), title=kw.pop("title", "Pump"), code=f"T-{gen_id()[:6]}",
                        attachment_ids=[], activity_ids=[], subtask_ids=[], created_at=now_iso(),
                        modified_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def tree(self, top_level="org", kid_level="org", inherited=False, **top):
        """A parent (owned by OWNER) and one subtask owned by OTHER.
        `inherited`: the subtask is private only because of the parent."""
        top.setdefault("owner_email", OWNER["email"])
        parent = self.task(title="Parent", access_level=top_level, **top)
        kid = self.task(title="Kid", access_level=kid_level, parent_task_id=parent.id,
                        owner_email=OTHER["email"], created_by=OTHER["email"],
                        narrowed_by=parent.id if inherited else "")
        parent.subtask_ids = [kid.id]
        self.db.commit()
        return parent, kid

    def patch(self, t, user=OWNER, **fields):
        return T.update_task(t.id, T.TaskUpdate(**fields), self.bg, user=user, db=self.db)

    def row(self, tid):
        self.db.expire_all()
        return self.db.get(models.Task, tid)

    def sees(self, user, tid):
        """The single-task rule (require_task_role's), the list, and the delta."""
        self.db.expire_all()
        one = task_visible_to(self.db, user, self.db.get(models.Task, tid))
        listed = any(r["id"] == tid for r in T.list_tasks(user=user, db=self.db))
        delta = any(r["id"] == tid for r in T.list_tasks_delta(since="", user=user, db=self.db)["tasks"])
        self.assertEqual(len({one, listed, delta}), 1, (one, listed, delta))
        return one

    def can_open(self, user, tid):
        try:
            T.list_checklist(tid, user=user, db=self.db)
            return True
        except HTTPException as e:
            self.db.rollback()
            self.assertEqual(e.status_code, 404)
            return False


class KeepPrivateTests(Base):
    def keep(self, t, user=OWNER):
        return T.keep_task_private(t.id, user=user, db=self.db)

    def refused(self, t, user, code):
        with self.assertRaises(HTTPException) as e:
            self.keep(t, user=user)
        self.db.rollback()
        self.assertEqual(e.exception.status_code, code)

    def acts(self, tid, type_):
        self.db.expire_all()
        return [a.detail for a in self.db.query(models.TaskActivity).filter_by(entity_id=tid, type=type_).all()]

    def test_the_subtasks_owner_keeps_it_and_the_parents_people_lose_it(self):
        parent, kid = self.tree(top_level="restricted", kid_level="restricted", inherited=True,
                                assignee_email=HELPER["email"], assignee_emails=[HELPER["email"]])
        for who in (OWNER, HELPER, OTHER):
            self.assertTrue(self.sees(who, kid.id), who)
        out = self.keep(kid, user=OTHER)
        self.assertEqual((out["accessLevel"], out["narrowedBy"]), ("restricted", ""))
        row = self.row(kid.id)
        self.assertEqual((row.access_level, row.narrowed_by, row.follower_emails or []), ("restricted", "", []))
        self.assertTrue(self.sees(OTHER, kid.id))
        self.assertFalse(self.sees(OWNER, kid.id))      # the parent's owner, not on the subtask
        self.assertFalse(self.sees(HELPER, kid.id))     # the parent's assignee
        self.assertEqual(self.acts(kid.id, "access_kept_private"),
                         ["kept this subtask private when its main task is shared"])
        # Sharing the parent again leaves it private.
        self.patch(parent, access_level="org")
        self.assertEqual(self.row(kid.id).access_level, "restricted")

    def test_someone_who_sees_it_only_through_the_parent_is_added_so_they_keep_it(self):
        parent, kid = self.tree(top_level="restricted", kid_level="restricted", inherited=True,
                                assignee_email=HELPER["email"], assignee_emails=[HELPER["email"]])
        self.keep(kid, user=HELPER)
        self.assertEqual(self.row(kid.id).follower_emails, [HELPER["email"]])
        self.assertTrue(self.sees(HELPER, kid.id))
        self.assertTrue(self.can_open(HELPER, kid.id))
        self.assertFalse(self.sees(OWNER, kid.id))
        self.assertEqual(self.acts(kid.id, "access_kept_private"),
                         ["kept this subtask private when its main task is shared and joined it as a collaborator"])

    def test_a_manager_is_never_added(self):
        mgr = {"email": "boss@greensglobal.com", "level": 3}
        self.db.add(models.NexusEmployee(id=gen_id(), work_email=mgr["email"], status="active",
                                         first_name="boss", company=COA))
        self.db.commit()
        _parent, kid = self.tree(top_level="restricted", kid_level="restricted", inherited=True)
        self.keep(kid, user=mgr)
        self.assertEqual(self.row(kid.id).follower_emails or [], [])

    def test_a_guest_reopener_is_never_added_to_rows_they_never_saw(self):
        parent, kid = self.tree(top_level="restricted", kid_level="restricted", inherited=True,
                                follower_emails=[EXT["email"]])
        self.assertFalse(self.sees(EXT, kid.id))
        k = self.row(kid.id)
        k.narrowed_by = ""
        self.assertEqual(T._pin_private(self.db, EXT, [k]), [])
        self.assertEqual(k.follower_emails or [], [])
        self.db.rollback()

    def test_an_outsider_and_a_guest_on_the_parent_are_refused(self):
        _parent, kid = self.tree(top_level="restricted", kid_level="restricted", inherited=True,
                                 follower_emails=[EXT["email"]])
        self.refused(kid, OUTSIDER, 404)
        self.refused(kid, EXT, 404)
        self.assertEqual(self.row(kid.id).narrowed_by, _parent.id)   # nothing changed

    def test_a_guest_on_the_subtask_may_keep_it_and_is_not_added(self):
        _parent, kid = self.tree(top_level="restricted", kid_level="restricted", inherited=True)
        kid.assignee_email, kid.assignee_emails = EXT["email"], [EXT["email"]]
        self.db.commit()
        self.keep(kid, user=EXT)
        row = self.row(kid.id)
        self.assertEqual((row.narrowed_by, row.follower_emails or []), ("", []))
        self.assertTrue(task_visible_to(self.db, EXT, row))

    def test_an_org_wide_subtask_is_refused_and_a_hand_restricted_one_unchanged(self):
        _p, open_kid = self.tree()
        self.refused(open_kid, OTHER, 422)
        _p2, hand = self.tree(top_level="restricted", kid_level="restricted")
        before = self.row(hand.id).modified_at
        self.keep(hand, user=OTHER)
        self.assertEqual((self.row(hand.id).narrowed_by, self.row(hand.id).modified_at), ("", before))
        self.assertEqual(self.acts(hand.id, "access_kept_private"), [])
        top = self.task(title="Top", access_level="restricted")
        self.refused(top, OWNER, 422)                   # not a subtask at all

    def test_opening_the_parent_and_keeping_its_subtasks_private(self):
        parent, kid = self.tree(top_level="restricted", kid_level="restricted", inherited=True,
                                assignee_email=HELPER["email"], assignee_emails=[HELPER["email"]])
        low = self.task(title="Low", access_level="restricted", parent_task_id=kid.id,
                        owner_email=OTHER["email"], narrowed_by=kid.id)
        kid.subtask_ids = [low.id]
        self.db.commit()
        self.patch(parent, access_level="org", keep_subtasks_private=True)
        k, lo = self.row(kid.id), self.row(low.id)
        self.assertEqual((self.row(parent.id).access_level, k.access_level, k.narrowed_by),
                         ("org", "restricted", ""))
        self.assertEqual((lo.access_level, lo.narrowed_by), ("restricted", kid.id))   # still follows kid
        self.assertEqual(k.follower_emails, [OWNER["email"]])   # the reopener keeps it
        for who in (OWNER, OTHER):
            self.assertTrue(self.sees(who, kid.id), who)
            self.assertTrue(self.sees(who, low.id), who)
        self.assertFalse(self.sees(HELPER, kid.id))
        self.assertFalse(self.sees(HELPER, low.id))
        self.assertEqual(self.acts(parent.id, "subtasks_access"),
                         ["1 subtask kept private, joined 1 as a collaborator"])
        # Private and shared again later: kid is private by hand now.
        self.patch(parent, access_level="restricted")
        self.patch(parent, access_level="org")
        self.assertEqual(self.row(kid.id).access_level, "restricted")

    def test_the_default_reopen_still_opens_them(self):
        parent, kid = self.tree(top_level="restricted", kid_level="restricted", inherited=True)
        self.patch(parent, access_level="org", keep_subtasks_private=False)
        self.assertEqual(self.row(kid.id).access_level, "org")

    def test_the_flag_on_any_other_edit_changes_nothing(self):
        parent, kid = self.tree(top_level="restricted", kid_level="restricted", inherited=True)
        self.patch(parent, title="Renamed", keep_subtasks_private=True)
        self.assertEqual((self.row(kid.id).narrowed_by, self.row(kid.id).follower_emails or []), (parent.id, []))
        self.assertEqual(self.row(parent.id).title, "Renamed")


if __name__ == "__main__":
    unittest.main()
