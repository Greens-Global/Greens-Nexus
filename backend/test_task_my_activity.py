"""GET /tasks/activity/mine - the Updates card on the Tasks Home (Oct 14 2026).

Other people's recent changes to the tasks I am assigned to or follow, newest
first; my own actions, the Asana sync markers, tasks I am not on and tasks in
the Trash stay out. Since Oct 15 2026 the feed is UPDATES: machine rows
(mailer, scheduler, sync, rules) stay out, one person's burst of edits on one
task is one update with `parts`, and what is aimed at me sets `forYou`.

Run with: python -m pytest test_task_my_activity.py
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi.routing import APIRoute

import database
import models
from routers import tasks as T
from routers.task_util import gen_id, now_iso


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(
            f"{__name__} deletes rows and is pointed at {actual!r}, not its own "
            f"temp database. Run it on its own: python -m pytest {__name__}.py"
        )


_assert_isolated()

ME = {"email": "neil@greensglobal.com", "level": 3}
OTHER = "sagar@greensglobal.com"


def _ago(minutes: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()


class MyActivityTests(unittest.TestCase):
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
        for m in (models.TaskActivity, models.TaskComment, models.TaskNotification, models.Task):
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _task(self, code, **kw):
        t = models.Task(id=gen_id(), code=code, title=f"{code} title", created_at=now_iso(),
                        modified_at=now_iso(), **kw)
        self.db.add(t)
        return t

    def _act(self, t, actor, type="commented", at=None, detail=""):
        self.db.add(models.TaskActivity(id=gen_id(), entity_kind="task", entity_id=t.id,
                                        entity_code=t.code, entity_title=t.title, type=type,
                                        actor_email=actor, at=at or now_iso(), detail=detail))

    def test_the_route_is_registered_where_the_task_id_route_cannot_shadow_it(self):
        route = next(r for r in T.router.routes
                     if isinstance(r, APIRoute) and "GET" in r.methods and r.path == "/tasks/activity/mine")
        self.assertIs(route.endpoint, T.my_task_activity)

    def test_only_other_peoples_changes_on_my_tasks_newest_first(self):
        assigned = self._task("TASK-A", assignee_emails=[ME["email"]])
        followed = self._task("TASK-F", assignee_emails=[OTHER], follower_emails=["Neil@GreensGlobal.com"])
        not_mine = self._task("TASK-N", assignee_emails=[OTHER])
        trashed = self._task("TASK-T", assignee_emails=[ME["email"]], deleted_at=now_iso())
        self._act(assigned, OTHER, at=_ago(30), detail="changed status to in_progress")
        self._act(followed, OTHER, type="completed", at=_ago(5), detail="completed this task")
        self._act(assigned, ME["email"], at=_ago(1))                       # my own action
        self._act(assigned, OTHER, type="synced_from_asana", at=_ago(2))   # sync bookkeeping
        self._act(not_mine, OTHER, at=_ago(3))
        self._act(trashed, OTHER, at=_ago(4))
        self._act(assigned, OTHER, at=_ago(60 * 24 * 20))                 # outside the window
        self.db.commit()

        rows = T.my_task_activity(limit=30, days=14, user=ME, db=self.db)
        self.assertEqual([(r["entityCode"], r["relation"]) for r in rows],
                         [("TASK-F", "collaborator"), ("TASK-A", "assignee")])
        self.assertEqual(rows[0]["taskId"], followed.id)
        self.assertEqual(rows[1]["detail"], "changed status to in_progress")

    def test_limit_and_window_are_honored_and_capped(self):
        t = self._task("TASK-A", assignee_emails=[ME["email"]])
        for i in range(5):   # two hours apart: five separate updates, not one burst
            self._act(t, OTHER, at=_ago(i * 120 + 1))
        self.db.commit()
        self.assertEqual(len(T.my_task_activity(limit=2, days=14, user=ME, db=self.db)), 2)
        self.assertEqual(len(T.my_task_activity(limit=1, days=14, user=ME, db=self.db)), 1)
        # a zero falls back to the defaults (30 rows, 14 days), never to nothing
        self.assertEqual(len(T.my_task_activity(limit=0, days=0, user=ME, db=self.db)), 5)
        self.assertEqual(len(T.my_task_activity(limit=500, days=14, user=ME, db=self.db)), 5)

    def test_only_peoples_actions_never_the_system_log(self):
        # Neil, Oct 18: "every single minor update about an email sent" and
        # "it keeps saying System".
        t = self._task("TASK-A", assignee_emails=[ME["email"]])
        for typ in ("notify_sent", "notify_failed", "notify_error", "recurrence_scheduled", "time_logged"):
            self._act(t, "system" if typ != "time_logged" else OTHER, type=typ, at=_ago(2))
        self._act(t, "automation@nexus", type="automation", at=_ago(2))
        self._act(t, "system", type="status_changed", at=_ago(2), detail="changed status to done")
        self._act(t, "", type="commented", at=_ago(2))
        self._act(t, OTHER, type="status_changed", at=_ago(3), detail="changed status to in_progress")
        self.db.commit()
        rows = T.my_task_activity(user=ME, db=self.db)
        self.assertEqual([(r["type"], r["actorId"]) for r in rows], [("status_changed", OTHER)])

    def test_a_flood_of_emails_does_not_push_real_updates_out(self):
        t = self._task("TASK-A", assignee_emails=[ME["email"]])
        self._act(t, OTHER, type="commented", at=_ago(500))
        for i in range(2100):
            self._act(t, "system", type="notify_sent", at=_ago(i % 400))
        self.db.commit()
        self.assertEqual([r["type"] for r in T.my_task_activity(user=ME, db=self.db)], ["commented"])

    def _comment(self, t, author, body, minutes):
        at = _ago(minutes)
        self.db.add(models.TaskComment(id=gen_id(), task_id=t.id, author_email=author, body=body, created_at=at))
        self._act(t, author, type="commented", at=at, detail="added a comment")

    def test_a_comment_carries_its_text_attributed_to_its_author(self):
        t = self._task("TASK-F", assignee_emails=[OTHER], follower_emails=[ME["email"]])
        self._comment(t, "pragya@greensglobal.com", "<p>Old note</p>", 100)   # past the hour: its own update
        self._comment(t, "pragya@greensglobal.com", "<p>Permit is <b>approved</b> &amp; filed</p>", 10)
        self.db.commit()
        rows = T.my_task_activity(user=ME, db=self.db)
        self.assertEqual([(r["actorId"], r["relation"], r["preview"]) for r in rows],
                         [("pragya@greensglobal.com", "collaborator", "Permit is approved & filed"),
                          ("pragya@greensglobal.com", "collaborator", "Old note")])

    def test_a_mention_on_a_task_i_am_not_on(self):
        t = self._task("TASK-N", assignee_emails=[OTHER])
        self._comment(t, OTHER, '<p>Can you check this <a href="mailto:neil@greensglobal.com">@Neil</a>?</p>', 5)
        self._comment(t, OTHER, "<p>Unrelated</p>", 6)
        self.db.commit()
        rows = T.my_task_activity(user=ME, db=self.db)
        self.assertEqual([(r["relation"], r["preview"]) for r in rows], [("mentioned", "Can you check this @Neil?")])

    def test_nothing_for_someone_on_no_task(self):
        t = self._task("TASK-A", assignee_emails=[OTHER])
        self._act(t, OTHER)
        self.db.commit()
        self.assertEqual(T.my_task_activity(user={"email": "dean@greensglobal.com", "level": 1}, db=self.db), [])
        self.assertEqual(T.my_task_activity(user={"email": "", "level": 1}, db=self.db), [])


    # ── Relevance and grouping (Oct 15 2026) ──
    def _kinds(self, row):
        return [(p["kind"], p["count"]) for p in row["parts"]]

    def test_machine_rows_and_bookkeeping_stay_out(self):
        t = self._task("TASK-A", assignee_emails=[ME["email"]])
        self._act(t, "system", type="notify_sent", at=_ago(1), detail=f"Recurring email sent to {OTHER} (assignee)")
        self._act(t, "system", type="recurrence_scheduled", at=_ago(2))
        self._act(t, "system", type="closed_missed", at=_ago(3))
        self._act(t, "asana-sync", type="created", at=_ago(4))
        self._act(t, "automation@nexus", type="automation", at=_ago(5))
        self._act(t, OTHER, type="time_logged", at=_ago(6), detail="logged 1h")
        self._act(t, OTHER, type="attachment_removed", at=_ago(7))
        self.db.commit()
        self.assertEqual(T.my_task_activity(user=ME, db=self.db), [])

    def test_one_persons_burst_on_one_task_is_one_update(self):
        t = self._task("TASK-A", assignee_emails=[ME["email"]])
        self._act(t, OTHER, type="attached", at=_ago(2), detail='attached "image.png"')
        self._act(t, OTHER, type="attached", at=_ago(3), detail='attached "image.png"')
        self._act(t, OTHER, type="status_changed", at=_ago(20), detail="changed status to in_progress")
        self._act(t, OTHER, type="due_changed", at=_ago(200), detail="changed the due date from 10/20/2026 to 10/22/2026")
        self.db.commit()
        rows = T.my_task_activity(user=ME, db=self.db)
        self.assertEqual(len(rows), 2)   # the due change is three hours earlier: its own update
        self.assertEqual(self._kinds(rows[0]), [("status", 1), ("attached", 2)])
        self.assertEqual(rows[0]["parts"][0]["detail"], "changed status to in_progress")
        self.assertEqual(self._kinds(rows[1]), [("due", 1)])
        self.assertFalse(rows[0]["forYou"])

    def test_completing_says_completed_not_also_the_status(self):
        t = self._task("TASK-A", assignee_emails=[ME["email"]])
        self._act(t, OTHER, type="completed", at=_ago(1))
        self._act(t, OTHER, type="status_changed", at=_ago(1), detail="changed status to done")
        self.db.commit()
        rows = T.my_task_activity(user=ME, db=self.db)
        self.assertEqual(self._kinds(rows[0]), [("completed", 1)])

    def test_a_followed_task_reports_only_its_headline_changes(self):
        t = self._task("TASK-F", assignee_emails=[OTHER], follower_emails=[ME["email"]])
        self._act(t, OTHER, type="attached", at=_ago(1))
        self._act(t, OTHER, type="checklist_done", at=_ago(2))
        self._act(t, OTHER, type="assignee_changed", at=_ago(3))
        self.db.commit()
        self.assertEqual(T.my_task_activity(user=ME, db=self.db), [])
        self._act(t, OTHER, type="completed", at=_ago(4))
        self.db.commit()
        rows = T.my_task_activity(user=ME, db=self.db)
        self.assertEqual((rows[0]["relation"], self._kinds(rows[0])), ("collaborator", [("completed", 1)]))

    def test_a_comment_carries_its_text_and_a_mention_is_for_me(self):
        t = self._task("TASK-A", assignee_emails=[ME["email"]])
        at = _ago(5)
        self.db.add(models.TaskComment(id=gen_id(), task_id=t.id, author_email=OTHER, created_at=at,
                                       body=f'<p>Can you check this, <a href="mailto:{ME["email"]}">@Neil</a>?</p>'))
        self._act(t, OTHER, type="commented", at=at, detail="added a comment")
        self.db.commit()
        row = T.my_task_activity(user=ME, db=self.db)[0]
        self.assertEqual(self._kinds(row), [("mentioned_you", 1), ("commented", 1)])
        self.assertTrue(row["forYou"])
        self.assertEqual(row["preview"], "Can you check this, @Neil?")

    def test_being_assigned_is_said_as_assigned_you(self):
        mine = self._task("TASK-A", assignee_emails=[ME["email"]])
        other = self._task("TASK-B", assignee_emails=[ME["email"], "dean@greensglobal.com"])
        at = _ago(10)
        self._act(mine, OTHER, type="created", at=at)
        self.db.add(models.TaskNotification(id=gen_id(), kind="task_assigned", for_email=ME["email"],
                                            task_id=mine.id, created_at=at, title="You were assigned a task"))
        # Somebody else was added to a task I already hold: no "assigned you".
        self._act(other, OTHER, type="assignee_changed", at=_ago(20))
        self.db.commit()
        rows = T.my_task_activity(user=ME, db=self.db)
        self.assertEqual([(r["entityCode"], self._kinds(r), r["forYou"]) for r in rows],
                         [("TASK-A", [("assigned_you", 1)], True), ("TASK-B", [("assignees", 1)], False)])


if __name__ == "__main__":
    unittest.main()
