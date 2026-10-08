"""
GET /me/work (the My Work dashboard tile, Oct 2026): the caller's open tasks
and tickets, bucketed by due date in THEIR local day.

Pins the grouping rule (overdue / today / week / later, tz offset honored),
that tasks and tickets land together, that other people's work, finished
work and trashed rows never appear, the per-group cap with uncapped counts,
and the requester's unread dot.

Throwaway sqlite. No network. Run ALONE: python -m pytest test_my_work.py
"""
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from unittest import mock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit

import database
import models
from routers import my_work as MW

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


ME = "sagar.shoundik@greensglobal.com"
OTHER = "neil@greensglobal.com"
USER = {"email": ME, "level": 1}
TODAY = "2026-10-08"


class PureRuleTests(unittest.TestCase):
    def test_local_today_follows_the_browser_offset(self):
        # 02:00 UTC on the 8th is still the 7th in New York (+300) and already
        # the 8th in Mumbai (-330); a nonsense offset reads as UTC.
        at = datetime(2026, 10, 8, 2, 0, tzinfo=timezone.utc)
        self.assertEqual(MW.local_today(300, at), "2026-10-07")
        self.assertEqual(MW.local_today(-330, at), "2026-10-08")
        self.assertEqual(MW.local_today(0, at), "2026-10-08")
        self.assertEqual(MW.local_today("x", at), "2026-10-08")

    def test_bucket_of(self):
        self.assertEqual(MW.bucket_of("2026-10-07", TODAY), "overdue")
        self.assertEqual(MW.bucket_of("2026-10-08", TODAY), "today")
        self.assertEqual(MW.bucket_of("2026-10-09", TODAY), "week")
        self.assertEqual(MW.bucket_of("2026-10-15", TODAY), "week")      # day 7 is still this week
        self.assertEqual(MW.bucket_of("2026-10-16", TODAY), "later")
        self.assertEqual(MW.bucket_of("", TODAY), "later")
        self.assertEqual(MW.bucket_of("not a date", TODAY), "later")
        self.assertEqual(MW.bucket_of("2026-10-08T15:00:00", TODAY), "today")   # a timestamp's date part

    def test_group_items_sorts_by_due_then_priority_and_caps(self):
        items = [{"id": str(i), "dueOn": "2026-10-01", "priority": "low", "title": f"t{i}"} for i in range(55)]
        items += [{"id": "u", "dueOn": "2026-10-01", "priority": "urgent", "title": "urgent one"},
                  {"id": "e", "dueOn": "2026-09-30", "priority": "low", "title": "earlier"},
                  {"id": "nd", "dueOn": "", "priority": "urgent", "title": "no date"},
                  {"id": "far", "dueOn": "2026-12-01", "priority": "low", "title": "far"}]
        g = MW.group_items(items, TODAY)
        self.assertEqual(len(g["overdue"]), MW.GROUP_CAP)
        self.assertEqual(g["counts"], {"overdue": 57, "today": 0, "week": 0, "later": 2, "total": 59})
        self.assertEqual([x["id"] for x in g["overdue"][:2]], ["e", "u"])
        self.assertEqual([x["id"] for x in g["later"]], ["far", "nd"])    # undated last
        self.assertEqual(g["localDate"], TODAY)


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.Task, models.TaskTicket, models.TaskProject, models.TaskCustomStatus,
                  models.HrDepartment, models.TicketDepartment):
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.commit()
        import auth
        self._grants = auth._grants_for
        auth._grants_for = lambda email, db: {}
        self.addCleanup(lambda: setattr(auth, "_grants_for", self._grants))
        # Local day pinned, so the fixtures below mean the same every day.
        p = mock.patch.object(MW, "local_today", return_value=TODAY)
        p.start()
        self.addCleanup(p.stop)

    def _task(self, due="", assignee=ME, assignees=None, **kw):
        t = models.Task(id=str(uuid.uuid4()), title=kw.pop("title", "T"), code=kw.pop("code", "TASK-1"),
                        assignee_email=assignee, assignee_emails=assignees if assignees is not None else ([assignee] if assignee else []),
                        due_on=due, status=kw.pop("status", "in_progress"), created_at="", modified_at="", **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def _ticket(self, due="", requester=ME, assignee="", **kw):
        t = models.TaskTicket(id=str(uuid.uuid4()), subject=kw.pop("subject", "Printer jam"), code=kw.pop("code", "000027"),
                              requester_email=requester, assignee_email=assignee, sla_due_on=due,
                              status=kw.pop("status", "open"), priority=kw.pop("priority", "medium"),
                              created_at="", modified_at="", **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def _call(self, tz=0, user=USER):
        return MW.my_work(tz_offset_min=tz, user=user, db=self.db)

    def _ids(self, group):
        return [x["id"] for x in group]

    def test_groups_tasks_and_tickets_by_the_callers_day(self):
        over = self._task("2026-10-07", title="Yesterday")
        today = self._task("2026-10-08", title="Today")
        week = self._task("2026-10-12", title="Soon")
        far = self._task("2026-11-20", title="Far")
        undated = self._task("", title="Whenever")
        tk = self._ticket("2026-10-08")
        out = self._call()
        self.assertEqual(self._ids(out["overdue"]), [over.id])
        self.assertEqual(set(self._ids(out["today"])), {today.id, tk.id})
        self.assertEqual(self._ids(out["week"]), [week.id])
        self.assertEqual(self._ids(out["later"]), [far.id, undated.id])
        self.assertEqual(out["counts"], {"overdue": 1, "today": 2, "week": 1, "later": 2, "total": 6})
        kinds = {x["id"]: x["kind"] for x in out["today"]}
        self.assertEqual(kinds, {today.id: "task", tk.id: "ticket"})
        self.assertEqual(out["localDate"], TODAY)

    def test_tz_offset_moves_the_day_boundary(self):
        MW.local_today.return_value = "2026-10-07"     # the browser is still on the 7th
        t = self._task("2026-10-07")
        out = self._call(tz=300)
        MW.local_today.assert_called_with(300)
        self.assertEqual(self._ids(out["today"]), [t.id])
        self.assertEqual(out["overdue"], [])

    def test_only_my_work(self):
        self._task("2026-10-08", assignee=OTHER)                              # someone else's task
        second = self._task("2026-10-08", assignee=OTHER, assignees=[OTHER, ME])  # I am the second assignee
        legacy = self._task("2026-10-08", assignee=ME, assignees=[])        # single-column row, pre multi-assignee
        self._ticket("2026-10-08", requester=OTHER, assignee=OTHER)          # someone else's ticket
        assigned = self._ticket("2026-10-08", requester=OTHER, assignee=ME)  # assigned to me
        filed = self._ticket("2026-10-08", requester=OTHER, created_by_email=ME)   # filed by me for them
        out = self._call()
        self.assertEqual(set(self._ids(out["today"])), {second.id, legacy.id, assigned.id, filed.id})
        self.assertEqual(out["counts"]["total"], 4)

    def test_finished_and_trashed_work_is_left_out(self):
        self._task("2026-10-08", completed=True)
        self._task("2026-10-08", deleted_at="2026-10-01T00:00:00")
        self._task("2026-10-08", type="section")
        self._ticket("2026-10-08", status="resolved")
        self._ticket("2026-10-08", status="closed")
        self._ticket("2026-10-08", deleted_at="2026-10-01T00:00:00")
        keep_task = self._task("2026-10-08")
        keep_tk = self._ticket("2026-10-08", status="waiting_user")
        out = self._call()
        self.assertEqual(set(self._ids(out["today"])), {keep_task.id, keep_tk.id})

    def test_item_shape_names_project_status_and_where_to_open(self):
        self.db.add(models.TaskProject(id="p1", name="Rollout"))
        self.db.add(models.TaskCustomStatus(id="cs1", label="Awaiting Review", position=1))
        self.db.add(models.HrDepartment(id="d1", company_id="c1", name="IT"))
        self.db.commit()
        t = self._task("2026-10-08", project_id="p1", status="cs1", priority="high", code="TASK-9", title="Ship it")
        sub = self._task("2026-10-08", parent_task_id=t.id, title="Child")   # project via the parent
        tk = self._ticket("2026-10-09", department_id="d1", priority="urgent", subject="VPN down")
        out = self._call()
        row = next(x for x in out["today"] if x["id"] == t.id)
        self.assertEqual(row, {"kind": "task", "id": t.id, "code": "TASK-9", "title": "Ship it", "project": "Rollout",
                               "dueOn": "2026-10-08", "status": "cs1", "statusLabel": "Awaiting Review",
                               "priority": "high", "unread": False, "view": "tasks", "sub": "", "taskId": t.id})
        child = next(x for x in out["today"] if x["id"] == sub.id)
        self.assertEqual((child["project"], child["statusLabel"]), ("Rollout", "In Progress"))
        trow = out["week"][0]
        self.assertEqual(trow, {"kind": "ticket", "id": tk.id, "code": "000027", "title": "VPN down", "project": "IT",
                                "dueOn": "2026-10-09", "status": "open", "statusLabel": "Open", "priority": "urgent",
                                "unread": False, "view": "support", "sub": "", "ticketId": tk.id})

    def test_desk_agents_open_tickets_on_the_desk(self):
        import auth
        auth._grants_for = lambda email, db: {"tickets": 99} if email == ME else {}
        self._ticket("2026-10-08")
        out = self._call()
        self.assertEqual(out["today"][0]["view"], "tickets")

    def test_unread_is_the_requesters_unseen_update(self):
        fresh = self._ticket("2026-10-08", requester_update_at="2026-10-08T10:00:00", requester_seen_at="2026-10-08T09:00:00")
        seen = self._ticket("2026-10-08", requester_update_at="2026-10-08T10:00:00", requester_seen_at="2026-10-08T11:00:00")
        never = self._ticket("2026-10-08", requester_update_at="2026-10-08T10:00:00", requester_seen_at="")
        quiet = self._ticket("2026-10-08")
        mine_as_agent = self._ticket("2026-10-08", requester=OTHER, assignee=ME,
                                     requester_update_at="2026-10-08T10:00:00", requester_seen_at="")
        unread = {x["id"]: x["unread"] for x in self._call()["today"]}
        self.assertEqual(unread, {fresh.id: True, seen.id: False, never.id: True, quiet.id: False, mine_as_agent.id: False})

    def test_sorted_by_due_then_priority_and_capped_at_fifty(self):
        for i in range(55):
            self._task("2026-10-01", priority="low", title=f"old {i}")
        urgent = self._task("2026-10-01", priority="urgent", title="urgent")
        earlier = self._task("2026-09-30", priority="low", title="earlier")
        out = self._call()
        self.assertEqual(len(out["overdue"]), 50)
        self.assertEqual(out["counts"]["overdue"], 57)
        self.assertEqual(self._ids(out["overdue"])[:2], [earlier.id, urgent.id])

    def test_nothing_open_is_the_empty_shape(self):
        out = self._call()
        self.assertEqual(out, {"overdue": [], "today": [], "week": [], "later": [],
                               "counts": {"overdue": 0, "today": 0, "week": 0, "later": 0, "total": 0},
                               "localDate": TODAY})


if __name__ == "__main__":
    unittest.main()
