"""
Project default view and shared dashboard charts (Oct 2026), plus the opaque
`data` document on a person's task table prefs that custom charts, the Home
layout and per-project view choices now live in.

Uses a throwaway sqlite file. No network.

Run with: python -m unittest test_task_project_views -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
from routers.task_util import gen_id, now_iso  # noqa: E402
from routers.task_projects import (  # noqa: E402
    update_project, create_project, put_shared_chart, delete_shared_chart, ProjectBody, clean_default_view,
)
from routers.task_prefs import set_table_prefs, get_prefs, TablePrefIn  # noqa: E402

OWNER = {"email": "owner@greensglobal.com", "level": 1}
EDITOR = {"email": "editor@greensglobal.com", "level": 1}
VIEWER = {"email": "viewer@greensglobal.com", "level": 1}


class ProjectViewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskProject, models.TaskTablePref):
            self.db.query(m).delete()
        self.db.commit()
        self.p = models.TaskProject(
            id=gen_id(), name="Ops", access_level="restricted", owner_email=OWNER["email"],
            member_emails=[EDITOR["email"], VIEWER["email"]],
            member_roles={EDITOR["email"]: "editor", VIEWER["email"]: "viewer"},
            created_at=now_iso(), modified_at=now_iso())
        self.db.add(self.p)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    # ── default view ────────────────────────────────────────────────────────
    def test_clean_default_view(self):
        self.assertEqual(clean_default_view({"view": "board", "group": "status"}), {"view": "board", "group": "status"})
        self.assertEqual(clean_default_view({"view": "spreadsheet", "group": "status"}), {"group": "status"})
        self.assertIsNone(clean_default_view({"view": "nope"}))
        self.assertIsNone(clean_default_view("board"))

    def test_owner_sets_and_clears_the_default_view(self):
        out = update_project(self.p.id, ProjectBody(default_view={"view": "board", "group": "assignee"}), user=OWNER, db=self.db)
        self.assertEqual(out["defaultView"], {"view": "board", "group": "assignee"})
        out = update_project(self.p.id, ProjectBody(default_view=None), user=OWNER, db=self.db)
        self.assertIsNone(out["defaultView"])

    def test_an_editor_may_not_set_the_default_view(self):
        with self.assertRaises(HTTPException) as cm:
            update_project(self.p.id, ProjectBody(default_view={"view": "board"}), user=EDITOR, db=self.db)
        self.assertEqual(cm.exception.status_code, 403)

    # ── shared charts ───────────────────────────────────────────────────────
    def test_an_editor_curates_shared_charts_a_viewer_does_not(self):
        chart = {"id": "c1", "title": "Open by status", "style": "bar", "dimension": "status", "metric": "count",
                 "filters": {"statuses": [], "priorities": [], "assigneeIds": []}}
        out = update_project(self.p.id, ProjectBody(shared_charts=[chart]), user=EDITOR, db=self.db)
        self.assertEqual([c["id"] for c in out["sharedCharts"]], ["c1"])
        with self.assertRaises(HTTPException):
            update_project(self.p.id, ProjectBody(shared_charts=[]), user=VIEWER, db=self.db)
        # Sending shared_charts alongside a settings field is a settings edit: owner only.
        with self.assertRaises(HTTPException):
            update_project(self.p.id, ProjectBody(shared_charts=[], name="Renamed"), user=EDITOR, db=self.db)

    def test_shared_charts_are_validated(self):
        with self.assertRaises(HTTPException):
            update_project(self.p.id, ProjectBody(shared_charts=[{"title": "no id"}]), user=OWNER, db=self.db)
        with self.assertRaises(HTTPException):
            update_project(self.p.id, ProjectBody(shared_charts=[{"id": str(i)} for i in range(30)]), user=OWNER, db=self.db)

    # ── opaque prefs data ───────────────────────────────────────────────────
    def test_a_shared_chart_is_whitelisted_to_what_the_dashboard_draws(self):
        bad = [{"id": "x", "style": "radar"}, {"id": "x", "filters": {"statuses": "all"}},
               {"id": "x", "metric": "sum_money"}, {"id": "x", "filters": {"statuses": [1, 2]}}]
        for chart in bad:
            with self.assertRaises(HTTPException, msg=chart):
                update_project(self.p.id, ProjectBody(shared_charts=[chart]), user=OWNER, db=self.db)
        out = update_project(self.p.id, ProjectBody(shared_charts=[{"id": "x", "title": "T", "evil": {"a": 1}}]),
                             user=OWNER, db=self.db)
        self.assertEqual(out["sharedCharts"], [{"id": "x", "title": "T", "style": "bar", "dimension": "status", "metric": "count",
                                               "filters": {"statuses": [], "priorities": [], "assigneeIds": []}, "dataLabels": True}])

    def test_one_chart_at_a_time_upserts_and_removes(self):
        chart = {"title": "Open", "style": "donut", "dimension": "priority", "metric": "count"}
        out = put_shared_chart(self.p.id, "c1", chart, user=EDITOR, db=self.db)
        out = put_shared_chart(self.p.id, "c2", {**chart, "title": "Two"}, user=EDITOR, db=self.db)
        self.assertEqual([c["id"] for c in out["sharedCharts"]], ["c1", "c2"])
        out = put_shared_chart(self.p.id, "c1", {**chart, "title": "Renamed"}, user=EDITOR, db=self.db)
        self.assertEqual([(c["id"], c["title"]) for c in out["sharedCharts"]], [("c1", "Renamed"), ("c2", "Two")], "in place")
        with self.assertRaises(HTTPException):
            put_shared_chart(self.p.id, "c3", chart, user=VIEWER, db=self.db)
        out = delete_shared_chart(self.p.id, "c1", user=EDITOR, db=self.db)
        self.assertEqual([c["id"] for c in out["sharedCharts"]], ["c2"])

    def test_create_honors_the_default_view(self):
        out = create_project(ProjectBody(name="New", default_view={"view": "board", "group": "status"}), user=OWNER, db=self.db)
        self.assertEqual(out["defaultView"], {"view": "board", "group": "status"})

    def test_prefs_data_round_trips_and_is_replaced_whole(self):
        set_table_prefs("charts", TablePrefIn(data={"workspace": [{"id": "a"}]}), user=OWNER, db=self.db)
        set_table_prefs("charts", TablePrefIn(data={"p1": [{"id": "b"}]}), user=OWNER, db=self.db)
        prefs = get_prefs(user=OWNER, db=self.db)["prefs"]
        self.assertEqual(prefs["charts"]["data"], {"p1": [{"id": "b"}]})
        # A column save on the same table leaves the data alone.
        set_table_prefs("charts", TablePrefIn(order=["x"]), user=OWNER, db=self.db)
        self.assertEqual(get_prefs(user=OWNER, db=self.db)["prefs"]["charts"]["data"], {"p1": [{"id": "b"}]})

    def test_prefs_data_is_capped(self):
        with self.assertRaises(HTTPException):
            set_table_prefs("charts", TablePrefIn(data={"big": "x" * 70_000}), user=OWNER, db=self.db)
        # ...and so is the whole document, not just one table of it.
        for i in range(4):
            set_table_prefs(f"t{i}", TablePrefIn(data={"big": "x" * 60_000}), user=OWNER, db=self.db)
        with self.assertRaises(HTTPException):
            set_table_prefs("t5", TablePrefIn(data={"big": "x" * 60_000}), user=OWNER, db=self.db)


if __name__ == "__main__":
    unittest.main()
