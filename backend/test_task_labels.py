"""Task labels done right (Oct 22 2026).

- The label map (colors and display names) per company behind the walls,
  one shared map with them off; only managers change it, another company's
  map is a 404.
- GET /task-labels lists only labels on tasks the caller can open - a
  restricted task's labels never leak; Manage's `all` view is a manager's.
- Rename / merge / delete rewrite every task in the company (restricted and
  trashed ones too), case-insensitively, with one quiet history row per task
  and no notifications, and never touch another company's tasks.
- The batch bar's Add Label / Remove Label merge per task, by key.

Throwaway SQLite, no network.  python -m pytest test_task_labels.py
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import auth
import cache
import database
import models
import task_labels as L
from routers import task_config as C
from routers import task_labels as R
from routers import task_projects as P
from routers import tasks as T
from routers.task_util import gen_id, now_iso


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

COA, COB = "co-a", "co-b"
AMGR = {"email": "amgr@greensglobal.com", "level": 3}   # company A manager, not a Global Admin
AEMP = {"email": "aemp@greensglobal.com", "level": 1}
BEMP = {"email": "bemp@greensglobal.com", "level": 1}
BMGR = {"email": "bmgr@greensglobal.com", "level": 3}
OUTSIDER = {"email": "outsider@greensglobal.com", "level": 1}
GA = {"email": "ga@greensglobal.com", "level": 4}       # bootstrap Global Admin, home company A
GA_NONE = {"email": "ga2@greensglobal.com", "level": 4}  # Global Admin with no company of their own

_CLEAR = (models.Task, models.TaskProject, models.TaskActivity, models.TaskNotification,
          models.NexusNotification, models.NexusEmployee, models.NexusSetting, models.HrEntity,
          models.TaskEmailQueue, models.TaskTeam, models.TaskSavedView)


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
        for m in _CLEAR:
            self.db.query(m).execution_options(include_deleted=True).delete()
        for email, co in ((AMGR["email"], COA), (AEMP["email"], COA), (BEMP["email"], COB),
                          (BMGR["email"], COB), (GA["email"], COA), (OUTSIDER["email"], COA),
                          (GA_NONE["email"], "")):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=email, first_name=email.split("@")[0],
                                             status="active", company=co))
        self.db.add(models.HrEntity(id=COA, name="Alpha"))
        self.db.add(models.HrEntity(id=COB, name="Bravo"))
        self.db.commit()
        cache.settings_config.invalidate()

    def tearDown(self):
        self.db.close()
        cache.settings_config.invalidate()

    def arm(self, on=True):
        self.db.query(models.NexusSetting).filter(models.NexusSetting.key == "company_walls").delete()
        if on:
            self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()

    def task(self, company=COA, **kw):
        kw.setdefault("title", "T")
        kw.setdefault("status", "not_started")
        kw.setdefault("owner_email", AMGR["email"] if company == COA else BMGR["email"])
        t = models.Task(id=gen_id(), code=f"T-{gen_id()[:6]}", company_id=company,
                        created_at=now_iso(), modified_at="2026-01-01T00:00:00+00:00", **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def code(self, call):
        with self.assertRaises(HTTPException) as e:
            call()
        self.db.rollback()
        return e.exception.status_code

    def tags(self, t):
        self.db.expire_all()
        return self.db.query(models.Task).execution_options(include_deleted=True) \
            .filter(models.Task.id == t.id).first().tags

    def labels(self, user, company="", all_tasks=False):
        return R.get_labels(company=company, all_tasks=all_tasks, user=user, db=self.db)

    def in_use(self, user, **kw):
        return {r["key"]: r for r in self.labels(user, **kw)["inUse"]}


class HelperTests(Base):
    def test_key_is_trimmed_collapsed_and_lowercased(self):
        self.assertEqual(L.label_key("  Q4   Close "), "q4 close")
        self.assertEqual(L.clean_name("  Q4   Close "), "Q4 Close")

    def test_merge_tags_is_case_insensitive_and_keeps_order(self):
        self.assertEqual(L.merge_tags(["Urgent", "Client"], add=["urgent", "New"]), ["Urgent", "Client", "New"])
        self.assertEqual(L.merge_tags(["Urgent", "Client"], remove=["URGENT"]), ["Client"])
        self.assertEqual(L.merge_tags(["a", "A", " b "], add=[]), ["a", "b"])

    def test_default_tone_is_deterministic_and_matches_the_browser(self):
        # The same vectors labels.test.js checks against labelTone.
        self.assertEqual(L.default_tone("urgent"), "red")
        self.assertEqual(L.default_tone("  URGENT "), "red")
        self.assertEqual(L.default_tone("client"), "blue")
        self.assertEqual(L.default_tone("marketing"), "green")
        self.assertEqual(L.default_tone("café"), "indigo")
        self.assertIn(L.default_tone("anything"), L.DEFAULT_TONES)


class PermissionTests(Base):
    """Through the real router, so its dependencies (require_manager, the
    Tasks Owner lift) run."""

    def client(self, user):
        app = FastAPI()
        app.include_router(R.router)
        app.dependency_overrides[auth.get_current_user] = lambda: dict(user)
        for d in R.router.dependencies:   # the module grant check: granted here
            if d.dependency is not auth.get_current_user:
                app.dependency_overrides[d.dependency] = lambda: None
        return TestClient(app)

    def test_an_employee_reads_but_cannot_change_labels(self):
        self.task(tags=["Urgent"])
        c = self.client(AEMP)
        self.assertEqual(c.get("/task-labels").status_code, 200)
        self.assertEqual(c.get("/task-labels?all=true").status_code, 401)
        self.assertEqual(c.put("/task-labels/color", json={"name": "Urgent", "color": "blue"}).status_code, 401)
        self.assertEqual(c.post("/task-labels/rename", json={"name": "Urgent", "to": "Hot"}).status_code, 401)
        self.assertEqual(c.post("/task-labels/delete", json={"name": "Urgent"}).status_code, 401)
        self.db.expire_all()
        self.assertEqual(L.get_map(self.db, ""), {})

    def test_a_manager_recolors(self):
        self.task(tags=["Urgent"])
        c = self.client(AMGR)
        r = c.put("/task-labels/color", json={"name": "urgent", "color": "blue"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["labels"]["urgent"], {"name": "urgent", "color": "blue"})
        self.assertEqual(c.put("/task-labels/color", json={"name": "Urgent", "color": "#ff0000"}).status_code, 422)
        self.assertEqual(c.put("/task-labels/color", json={"name": "  ", "color": "blue"}).status_code, 422)
        # Back to the default.
        self.assertEqual(c.put("/task-labels/color", json={"name": "Urgent", "color": ""}).json()["labels"]["urgent"]["color"], "")


class SuggestionTests(Base):
    def test_restricted_task_labels_reach_only_those_who_can_open_it(self):
        self.task(tags=["Shared"])
        self.task(tags=["Secret Deal"], access_level="restricted", owner_email=AEMP["email"],
                  created_by=AEMP["email"])
        self.assertNotIn("secret deal", self.in_use(OUTSIDER))
        self.assertIn("shared", self.in_use(OUTSIDER))
        self.assertIn("secret deal", self.in_use(AEMP))
        self.assertIn("secret deal", self.in_use(AMGR))   # a manager sees every task
        # Manage's view is a manager's.
        self.assertEqual(self.code(lambda: self.labels(OUTSIDER, all_tasks=True)), 401)

    def test_counts_and_the_common_spelling(self):
        self.task(tags=["Urgent"])
        self.task(tags=["Urgent", "Client"])
        self.task(tags=["urgent"])
        got = self.in_use(AMGR)
        self.assertEqual(got["urgent"]["count"], 3)
        self.assertEqual(got["urgent"]["name"], "Urgent")
        self.assertEqual(got["client"]["count"], 1)

    def test_trashed_tasks_are_not_suggested(self):
        self.task(tags=["Gone"], deleted_at=now_iso())
        self.assertNotIn("gone", self.in_use(AMGR))

    def test_walls_keep_each_company_to_its_own_labels(self):
        self.task(COA, tags=["Alpha Only"])
        self.task(COB, tags=["Bravo Only"])
        self.arm()
        self.assertEqual(set(self.in_use(AMGR)), {"alpha only"})
        self.assertEqual(set(self.in_use(BEMP)), {"bravo only"})
        self.assertEqual(self.code(lambda: self.labels(AMGR, company=COB)), 404)
        # A Global Admin can look at either.
        self.assertEqual(set(self.in_use(GA, company=COB)), {"bravo only"})
        self.assertEqual({c["id"] for c in self.labels(GA)["companies"]}, {COA, COB})
        self.assertEqual({c["id"] for c in self.labels(AMGR)["companies"]}, {COA})


class MapTests(Base):
    def test_walls_off_one_shared_map(self):
        R.set_color(R.ColorBody(name="Urgent", color="amber"), user=AMGR, db=self.db)
        self.assertEqual(self.labels(BEMP)["labels"]["urgent"]["color"], "amber")
        self.assertEqual(self.labels(BEMP)["companyId"], "")
        self.assertEqual(self.labels(BEMP)["companies"], [])

    def test_walls_on_each_company_has_its_own_map(self):
        self.arm()
        R.set_color(R.ColorBody(name="Urgent", color="amber"), user=AMGR, db=self.db)
        R.set_color(R.ColorBody(name="Urgent", color="teal"), user=BMGR, db=self.db)
        self.assertEqual(self.labels(AEMP)["labels"]["urgent"]["color"], "amber")
        self.assertEqual(self.labels(BEMP)["labels"]["urgent"]["color"], "teal")
        self.assertEqual(L.get_map(self.db, ""), {})
        # Another company's map is a 404 for a manager behind the wall.
        self.assertEqual(self.code(lambda: R.set_color(R.ColorBody(name="Urgent", color="red", company=COB),
                                                       user=AMGR, db=self.db)), 404)
        self.assertEqual(self.labels(BEMP)["labels"]["urgent"]["color"], "teal")
        # A Global Admin may change any company's; one with no company must name one.
        R.set_color(R.ColorBody(name="Urgent", color="red", company=COB), user=GA, db=self.db)
        self.assertEqual(self.labels(BEMP)["labels"]["urgent"]["color"], "red")
        self.assertEqual(self.code(lambda: R.set_color(R.ColorBody(name="Urgent", color="red"),
                                                       user=GA_NONE, db=self.db)), 422)


class RewriteTests(Base):
    def test_rename_rewrites_every_task_in_the_company_case_insensitively(self):
        a = self.task(tags=["Urgent", "Client"])
        b = self.task(tags=["URGENT"])
        secret = self.task(tags=["urgent"], access_level="restricted", owner_email=AEMP["email"])
        binned = self.task(tags=["Urgent"], deleted_at=now_iso())
        other = self.task(tags=["Client"])
        r = R.rename_label(R.RenameBody(name="urgent", to="Critical"), user=AMGR, db=self.db)
        self.assertEqual(r["changed"], 4)
        self.assertFalse(r["merged"])
        self.assertEqual(self.tags(a), ["Critical", "Client"])
        self.assertEqual(self.tags(b), ["Critical"])
        self.assertEqual(self.tags(secret), ["Critical"])
        self.assertEqual(self.tags(binned), ["Critical"])
        self.assertEqual(self.tags(other), ["Client"])
        # One quiet history row per changed task, nothing for the others.
        rows = self.db.query(models.TaskActivity).all()
        self.assertEqual(sorted(x.entity_id for x in rows), sorted([a.id, b.id, secret.id, binned.id]))
        for x in rows:
            self.assertEqual(x.type, "field_changed")
            self.assertEqual(x.field_change["field"], "tags")
        ch = next(x for x in rows if x.entity_id == a.id).field_change
        self.assertEqual((ch["from"], ch["to"]), (["Urgent", "Client"], ["Critical", "Client"]))
        # No bell, no email.
        self.assertEqual(self.db.query(models.TaskNotification).count(), 0)
        self.assertEqual(self.db.query(models.TaskEmailQueue).count(), 0)
        # Open lists pick it up on their next delta.
        self.db.expire_all()
        self.assertGreater(self.db.get(models.Task, a.id).modified_at, "2026-01-01T00:00:00+00:00")

    def test_rename_keeps_the_color_the_label_showed(self):
        self.task(tags=["Urgent"])
        self.task(tags=["Client"])
        R.set_color(R.ColorBody(name="Client", color="purple"), user=AMGR, db=self.db)
        R.rename_label(R.RenameBody(name="Client", to="Customer"), user=AMGR, db=self.db)
        R.rename_label(R.RenameBody(name="Urgent", to="Hot"), user=AMGR, db=self.db)
        m = L.get_map(self.db, "")
        self.assertNotIn("client", m)
        self.assertEqual(m["customer"], {"name": "Customer", "color": "purple"})
        self.assertEqual(m["hot"]["color"], L.default_tone("urgent"))   # red, as "Urgent" showed

    def test_renaming_onto_a_label_in_use_merges(self):
        both = self.task(tags=["Blocker", "Urgent", "Client"])
        one = self.task(tags=["blocker"])
        self.task(tags=["Urgent"])
        R.set_color(R.ColorBody(name="Blocker", color="amber"), user=AMGR, db=self.db)
        r = R.rename_label(R.RenameBody(name="Blocker", to="urgent"), user=AMGR, db=self.db)
        self.assertTrue(r["merged"])
        self.assertEqual(r["name"], "Urgent")          # the target's own spelling wins
        self.assertEqual(self.tags(both), ["Urgent", "Client"])
        self.assertEqual(self.tags(one), ["Urgent"])
        m = L.get_map(self.db, "")
        self.assertNotIn("blocker", m)
        self.assertNotIn("urgent", m)                   # the target keeps its own (default) color
        self.assertEqual({k: v["count"] for k, v in {x["key"]: x for x in r["inUse"]}.items()},
                         {"urgent": 3, "client": 1})

    def test_a_spelling_change_normalizes_every_variant(self):
        a, b = self.task(tags=["urgent"]), self.task(tags=["URGENT", "x"])
        r = R.rename_label(R.RenameBody(name="urgent", to="Urgent"), user=AMGR, db=self.db)
        self.assertFalse(r["merged"])
        self.assertEqual((self.tags(a), self.tags(b)), (["Urgent"], ["Urgent", "x"]))
        self.assertEqual(L.get_map(self.db, "")["urgent"], {"name": "Urgent", "color": ""})

    def test_delete_takes_the_label_off_everything_and_forgets_its_color(self):
        a = self.task(tags=["Urgent", "Client"])
        binned = self.task(tags=["urgent"], deleted_at=now_iso())
        R.set_color(R.ColorBody(name="Urgent", color="blue"), user=AMGR, db=self.db)
        r = R.delete_label(R.DeleteBody(name="URGENT"), user=AMGR, db=self.db)
        self.assertEqual(r["changed"], 2)
        self.assertEqual((self.tags(a), self.tags(binned)), (["Client"], []))
        self.assertNotIn("urgent", L.get_map(self.db, ""))

    def test_an_unknown_label_cannot_be_renamed(self):
        self.assertEqual(self.code(lambda: R.rename_label(R.RenameBody(name="Nope", to="Yes"),
                                                          user=AMGR, db=self.db)), 404)

    def test_behind_the_walls_a_rewrite_stays_in_its_company(self):
        a, b = self.task(COA, tags=["Urgent"]), self.task(COB, tags=["Urgent"])
        self.arm()
        R.rename_label(R.RenameBody(name="Urgent", to="Hot"), user=AMGR, db=self.db)
        R.delete_label(R.DeleteBody(name="Urgent"), user=AMGR, db=self.db)
        self.assertEqual((self.tags(a), self.tags(b)), (["Hot"], ["Urgent"]))
        self.assertEqual(self.code(lambda: R.delete_label(R.DeleteBody(name="Urgent", company=COB),
                                                          user=AMGR, db=self.db)), 404)
        self.assertEqual(self.tags(b), ["Urgent"])
        # The Global Admin with no company of their own must pick one.
        self.assertEqual(self.code(lambda: R.delete_label(R.DeleteBody(name="Urgent"), user=GA_NONE,
                                                          db=self.db)), 422)
        R.delete_label(R.DeleteBody(name="Urgent", company=COB), user=GA_NONE, db=self.db)
        self.assertEqual(self.tags(b), [])


class BulkTests(Base):
    def bulk(self, ids, user=AMGR, **kw):
        return T.bulk_update(T.BulkUpdate(ids=ids, **kw), user=user, db=self.db)

    def test_add_merges_by_key(self):
        a, b = self.task(tags=["Urgent"]), self.task(tags=["Client"])
        out = {r["id"]: r for r in self.bulk([a.id, b.id], tags_add=["urgent"])}
        self.assertEqual(out[a.id]["tags"], ["Urgent"])
        self.assertEqual(out[b.id]["tags"], ["Client", "urgent"])
        # History only where something changed.
        rows = self.db.query(models.TaskActivity).filter(models.TaskActivity.type == "field_changed").all()
        self.assertEqual([x.entity_id for x in rows], [b.id])
        self.assertEqual(rows[0].field_change["to"], ["Client", "urgent"])

    def test_remove_is_case_insensitive(self):
        a, b = self.task(tags=["Urgent", "Client"]), self.task(tags=["Client"])
        out = {r["id"]: r for r in self.bulk([a.id, b.id], tags_remove=["URGENT"])}
        self.assertEqual(out[a.id]["tags"], ["Client"])
        self.assertEqual(out[b.id]["tags"], ["Client"])

    def test_add_and_remove_together(self):
        a = self.task(tags=["Old", "Keep"])
        out = self.bulk([a.id], tags_add=["New"], tags_remove=["old"])
        self.assertEqual(out[0]["tags"], ["Keep", "New"])

    def test_refused_shapes(self):
        a = self.task(tags=["x"])
        self.assertEqual(self.code(lambda: self.bulk([a.id], patch={"tags": ["y"]}, tags_add=["z"])), 422)
        self.assertEqual(self.code(lambda: self.bulk([a.id], tags_add=["  "], tags_remove=[])), 422)
        self.assertEqual(self.code(lambda: self.bulk([a.id], tags_add=["x" * 61])), 422)
        full = self.task(tags=[f"l{i}" for i in range(30)])
        self.assertEqual(self.code(lambda: self.bulk([full.id], tags_add=["one more"])), 422)
        self.assertEqual(self.tags(a), ["x"])

    def test_someone_who_cannot_edit_is_refused(self):
        proj = models.TaskProject(id=gen_id(), name="P", access_level="restricted", created_at=now_iso(),
                                  member_emails=[AEMP["email"]], member_roles={AEMP["email"]: "viewer"})
        self.db.add(proj)
        self.db.commit()
        a = self.task(tags=["x"], project_id=proj.id)
        self.assertEqual(self.code(lambda: self.bulk([a.id], user=AEMP, tags_add=["y"])), 403)
        self.assertEqual(self.code(lambda: self.bulk([a.id], user=OUTSIDER, tags_add=["y"])), 403)
        self.assertEqual(self.tags(a), ["x"])

    def test_walls_refuse_another_companys_task(self):
        a, b = self.task(COA, tags=[]), self.task(COB, tags=[])
        self.arm()
        self.assertEqual(self.code(lambda: self.bulk([a.id, b.id], tags_add=["y"])), 404)
        self.assertEqual((self.tags(a), self.tags(b)), ([], []))


class ViewTests(Base):
    def test_a_saved_view_keeps_the_labels_filter_and_the_label_grouping(self):
        C.create_saved_view(C.SavedViewBody(name="Hot", view="list", group="label",
                                            filters={"tags": ["urgent", "client"]}), user=AEMP, db=self.db)
        v = C.list_saved_views(user=AEMP, db=self.db)[0]
        self.assertEqual((v["group"], v["filters"]["tags"]), ("label", ["urgent", "client"]))

    def test_a_project_default_view_keeps_the_label_grouping(self):
        self.assertEqual(P.clean_default_view({"view": "list", "group": "label"}), {"view": "list", "group": "label"})


if __name__ == "__main__":
    unittest.main()
