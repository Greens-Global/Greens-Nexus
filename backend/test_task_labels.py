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
import task_automation
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
          models.TaskEmailQueue, models.TaskTeam, models.TaskSavedView, models.TaskAutomationRule,
          models.TaskTablePref, models.TaskTemplate)


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
        L._cache_drop()

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
        """Manage's list (managers, `all`)."""
        return {r["key"]: r for r in self.labels(user, all_tasks=True, **kw)["inUse"]}

    def seen(self, user, **kw):
        """The map keys a caller is handed on a plain read."""
        return set(self.labels(user, **kw)["labels"])

    def color(self, name, tone, user=AMGR, company=""):
        R.set_color(R.ColorBody(name=name, color=tone, company=company), user=user, db=self.db)


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
        # Back to the default: an entry with no color is not kept (the map
        # holds only what changes something).
        self.assertNotIn("urgent", c.put("/task-labels/color", json={"name": "Urgent", "color": ""}).json()["labels"])
        self.assertEqual(L.get_map(self.db, ""), {})


class VisibilityTests(Base):
    def test_a_plain_read_names_only_labels_on_tasks_the_caller_can_open(self):
        self.task(tags=["Shared"])
        self.task(tags=["Secret Deal"], access_level="restricted", owner_email=AEMP["email"],
                  created_by=AEMP["email"])
        self.color("Shared", "blue")
        self.color("Secret Deal", "red")
        self.assertEqual(self.seen(OUTSIDER), {"shared"})
        self.assertEqual(self.seen(AEMP), {"shared", "secret deal"})
        self.assertEqual(self.seen(AMGR), {"shared", "secret deal"})   # a manager sees every task
        # The labels in use are Manage's alone.
        self.assertNotIn("inUse", self.labels(OUTSIDER))
        self.assertEqual(self.code(lambda: self.labels(OUTSIDER, all_tasks=True)), 401)

    def test_a_rename_of_a_restricted_only_label_does_not_leak_its_name(self):
        # The review's probe: a rename writes the new name into the map (to
        # keep its color); it must still reach only those who can open it.
        self.task(tags=["Secret Deal"], access_level="restricted", owner_email=AEMP["email"],
                  created_by=AEMP["email"])
        R.rename_label(R.RenameBody(name="Secret Deal", to="Project Falcon Acquisition"), user=AMGR, db=self.db)
        self.assertIn("project falcon acquisition", L.get_map(self.db, ""))
        got = self.labels(OUTSIDER)
        self.assertEqual(got["labels"], {})
        self.assertNotIn("Falcon", str(got))
        self.assertEqual(self.seen(AEMP), {"project falcon acquisition"})

    def test_a_project_member_sees_labels_on_a_restricted_projects_tasks(self):
        proj = models.TaskProject(id=gen_id(), name="P", access_level="restricted", created_at=now_iso(),
                                  member_emails=[OUTSIDER["email"]])
        self.db.add(proj)
        self.db.commit()
        self.task(tags=["Plant"], access_level="restricted", project_id=proj.id, owner_email=AEMP["email"])
        self.color("Plant", "green")
        self.assertEqual(self.seen(OUTSIDER), {"plant"})
        self.assertEqual(self.seen(BEMP), set())

    def test_trashed_tasks_reveal_nothing(self):
        self.task(tags=["Gone"], deleted_at=now_iso())
        self.color("Gone", "pink")
        self.assertEqual(self.seen(AMGR), set())
        self.assertNotIn("gone", self.in_use(AMGR))

    def test_counts_and_the_common_spelling(self):
        self.task(tags=["Urgent"])
        self.task(tags=["Urgent", "Client"])
        self.task(tags=["urgent"])
        got = self.in_use(AMGR)
        self.assertEqual(got["urgent"]["count"], 3)
        self.assertEqual(got["urgent"]["name"], "Urgent")
        self.assertEqual(got["client"]["count"], 1)

    def test_walls_keep_each_company_to_its_own_labels(self):
        self.task(COA, tags=["Alpha Only"])
        self.task(COB, tags=["Bravo Only"])
        self.arm()
        self.assertEqual(set(self.in_use(AMGR)), {"alpha only"})
        self.assertEqual(set(self.in_use(BMGR)), {"bravo only"})
        self.assertEqual(self.code(lambda: self.labels(AMGR, company=COB)), 404)
        # A Global Admin can look at either.
        self.assertEqual(set(self.in_use(GA, company=COB)), {"bravo only"})
        self.assertEqual({c["id"] for c in self.labels(GA)["companies"]}, {COA, COB})
        self.assertEqual({c["id"] for c in self.labels(AMGR)["companies"]}, {COA})

    def test_a_global_admin_with_no_company_lands_on_the_first_one(self):
        self.task(COA, tags=["Alpha"])
        self.arm()
        got = self.labels(GA_NONE, all_tasks=True)
        self.assertEqual(got["companyId"], got["companies"][0]["id"])
        self.assertEqual(got["companyId"], COA)            # "Alpha" sorts first
        self.assertEqual([r["key"] for r in got["inUse"]], ["alpha"])

    def test_the_memo_is_dropped_by_a_change(self):
        self.task(tags=["Urgent"])
        self.color("Urgent", "blue")
        self.assertEqual(self.seen(OUTSIDER), {"urgent"})
        R.delete_label(R.DeleteBody(name="Urgent"), user=AMGR, db=self.db)
        self.color("Urgent", "blue")
        self.assertEqual(self.seen(OUTSIDER), set())


class MapTests(Base):
    def test_walls_off_one_shared_map(self):
        self.task(COB, tags=["Urgent"])
        R.set_color(R.ColorBody(name="Urgent", color="amber"), user=AMGR, db=self.db)
        self.assertEqual(self.labels(BEMP)["labels"]["urgent"]["color"], "amber")
        self.assertEqual(self.labels(BEMP)["companyId"], "")
        self.assertEqual(self.labels(BEMP)["companies"], [])

    def test_walls_on_each_company_has_its_own_map(self):
        self.task(COA, tags=["Urgent"])
        self.task(COB, tags=["Urgent"])
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
        # A Global Admin may change any company's.
        R.set_color(R.ColorBody(name="Urgent", color="red", company=COB), user=GA, db=self.db)
        self.assertEqual(self.labels(BEMP)["labels"]["urgent"]["color"], "red")


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
        self.assertNotIn("urgent", L.get_map(self.db, ""))   # nothing to keep: no color

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
        # A Global Admin with no company of their own acts on the first one
        # listed (Alpha) unless they pick another.
        R.delete_label(R.DeleteBody(name="Urgent"), user=GA_NONE, db=self.db)
        self.assertEqual(self.tags(b), ["Urgent"])
        R.delete_label(R.DeleteBody(name="Urgent", company=COB), user=GA_NONE, db=self.db)
        self.assertEqual(self.tags(b), [])

    def test_with_no_company_at_all_nothing_can_be_changed(self):
        self.db.query(models.HrEntity).delete()
        self.db.commit()
        self.arm()
        self.assertEqual(self.code(lambda: R.delete_label(R.DeleteBody(name="Urgent"), user=GA_NONE,
                                                          db=self.db)), 422)


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
        # On their own, like the Dates action.
        self.assertEqual(self.code(lambda: self.bulk([a.id], patch={"priority": "high"}, tags_add=["z"])), 422)
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


class WritePathTests(Base):
    """Integration (Oct 22 2026): the drawer / create / import save path and
    Manage > Labels apply ONE label rule - merged by key, a NEW label at most
    MAX_NAME characters, at most MAX_PER_TASK - and a label stored before the
    cap (or by an old import) can still be recolored, renamed, deleted and
    removed in bulk."""
    LONG = "A very long label that somebody typed before the cap existed, seventy"

    def patch(self, t, tags):
        from fastapi import BackgroundTasks
        return T.update_task(t.id, T.TaskUpdate(tags=tags), BackgroundTasks(), user=AMGR, db=self.db)

    def test_a_save_merges_spacing_and_case_variants(self):
        t = self.task(tags=[])
        self.assertEqual(self.patch(t, ["Q4 launch", "Q4  launch", " q4 LAUNCH ", "Ops"])["tags"], ["Q4 launch", "Ops"])

    def test_a_new_label_keeps_the_length_and_count_rules(self):
        t = self.task(tags=["x"])
        self.assertEqual(self.code(lambda: self.patch(t, ["x", "y" * 61])), 422)
        self.assertEqual(self.code(lambda: self.patch(t, [f"l{i}" for i in range(31)])), 422)
        self.assertEqual(self.tags(t), ["x"])
        self.assertEqual(len(self.patch(t, [f"l{i}" for i in range(30)])["tags"]), 30)

    def test_a_label_already_on_the_task_is_kept_whatever_its_length(self):
        self.assertGreater(len(self.LONG), L.MAX_NAME)
        t = self.task(tags=[self.LONG, "Old"])
        self.assertEqual(self.patch(t, [self.LONG, "New"])["tags"], [self.LONG, "New"])

    def test_a_long_legacy_label_can_still_be_managed(self):
        a, b = self.task(tags=[self.LONG, "Keep"]), self.task(tags=[self.LONG])
        R.set_color(R.ColorBody(name=self.LONG, color="red"), user=AMGR, db=self.db)
        self.assertEqual(L.get_map(self.db, "")[L.label_key(self.LONG)]["color"], "red")
        self.assertEqual(R.label_impact(name=self.LONG, user=AMGR, db=self.db)["tasks"], 2)
        T.bulk_update(T.BulkUpdate(ids=[a.id], tags_remove=[self.LONG]), user=AMGR, db=self.db)
        self.assertEqual(self.tags(a), ["Keep"])
        R.rename_label(R.RenameBody(name=self.LONG, to="Short"), user=AMGR, db=self.db)
        self.assertEqual(self.tags(b), ["Short"])
        # A NEW name still keeps the cap.
        self.assertEqual(self.code(lambda: R.rename_label(R.RenameBody(name="Short", to="z" * 61),
                                                          user=AMGR, db=self.db)), 422)
        c = self.task(tags=[self.LONG])
        R.delete_label(R.DeleteBody(name=self.LONG), user=AMGR, db=self.db)
        self.assertEqual(self.tags(c), [])


class ViewTests(Base):
    def test_a_saved_view_keeps_the_labels_filter_and_the_label_grouping(self):
        C.create_saved_view(C.SavedViewBody(name="Hot", view="list", group="label",
                                            filters={"tags": ["urgent", "client"]}), user=AEMP, db=self.db)
        v = C.list_saved_views(user=AEMP, db=self.db)[0]
        self.assertEqual((v["group"], v["filters"]["tags"]), ("label", ["urgent", "client"]))

    def test_a_project_default_view_keeps_the_label_grouping(self):
        self.assertEqual(P.clean_default_view({"view": "list", "group": "label"}), {"view": "list", "group": "label"})


def _color_rule(value, field="tags"):
    return {"id": gen_id(), "name": "Hot", "color": "#dc2626", "bold": False, "enabled": True, "match": "all",
            "conditions": [{"field": field, "op": "contains", "value": value}]}


class CarryThroughTests(Base):
    """Rename and delete reach what NAMES a label, in the same transaction."""

    def rule(self, company="", conditions=(), actions=()):
        r = models.TaskAutomationRule(id=gen_id(), name="R", trigger={"type": "created"}, enabled=True,
                                      conditions=list(conditions), actions=list(actions), company_id=company)
        self.db.add(r)
        self.db.commit()
        return r

    def get(self, model, rid):
        self.db.expire_all()
        return self.db.get(model, rid)

    def test_rename_renames_rule_conditions_and_add_tag_actions(self):
        self.task(tags=["Urgent"])
        r = self.rule(conditions=[{"field": "tag", "op": "is", "value": " URGENT "},
                                  {"field": "priority", "op": "is", "value": "urgent"}],
                      actions=[{"type": "add_tag", "value": "urgent"}, {"type": "set_priority", "value": "high"}])
        out = R.rename_label(R.RenameBody(name="Urgent", to="Critical"), user=AMGR, db=self.db)
        self.assertEqual(out["also"]["automationRules"], 1)
        r = self.get(models.TaskAutomationRule, r.id)
        self.assertEqual(r.conditions, [{"field": "tag", "op": "is", "value": "Critical"},
                                        {"field": "priority", "op": "is", "value": "urgent"}])
        self.assertEqual(r.actions, [{"type": "add_tag", "value": "Critical"}, {"type": "set_priority", "value": "high"}])

    def test_delete_drops_add_tag_actions_and_leaves_conditions(self):
        self.task(tags=["Urgent"])
        tests = self.rule(conditions=[{"field": "tag", "op": "is", "value": "urgent"}],
                          actions=[{"type": "set_priority", "value": "high"}])
        adds = self.rule(actions=[{"type": "add_tag", "value": "Urgent"}, {"type": "set_priority", "value": "high"}])
        only = self.rule(actions=[{"type": "add_tag", "value": "URGENT"}])
        out = R.delete_label(R.DeleteBody(name="Urgent"), user=AMGR, db=self.db)
        self.assertEqual(out["also"]["rulesStillNaming"], 1)
        self.assertEqual(out["also"]["automationRules"], 2)
        self.assertEqual(out["also"]["rulesDisabled"], 1)
        self.assertEqual(self.get(models.TaskAutomationRule, tests.id).conditions[0]["value"], "urgent")
        self.assertEqual(self.get(models.TaskAutomationRule, adds.id).actions, [{"type": "set_priority", "value": "high"}])
        gone = self.get(models.TaskAutomationRule, only.id)
        self.assertEqual((gone.actions, gone.enabled), ([], False))

    def test_behind_the_walls_only_the_companys_rules_change(self):
        self.task(COA, tags=["Urgent"])
        mine = self.rule(COA, actions=[{"type": "add_tag", "value": "Urgent"}])
        theirs = self.rule(COB, actions=[{"type": "add_tag", "value": "Urgent"}])
        shared = self.rule("", actions=[{"type": "add_tag", "value": "Urgent"}])
        self.arm()
        out = R.rename_label(R.RenameBody(name="Urgent", to="Hot"), user=AMGR, db=self.db)
        self.assertEqual((out["also"]["automationRules"], out["also"]["sharedRules"]), (1, 1))
        self.assertEqual(self.get(models.TaskAutomationRule, mine.id).actions[0]["value"], "Hot")
        self.assertEqual(self.get(models.TaskAutomationRule, theirs.id).actions[0]["value"], "Urgent")
        self.assertEqual(self.get(models.TaskAutomationRule, shared.id).actions[0]["value"], "Urgent")

    def test_project_row_colors_are_renamed_in_the_company(self):
        self.task(COA, tags=["Urgent"])
        pa = models.TaskProject(id=gen_id(), name="A", company_id=COA, created_at=now_iso(), modified_at="2026-01-01",
                                color_rules=[_color_rule("urgent"), _color_rule("other")])
        pb = models.TaskProject(id=gen_id(), name="B", company_id=COB, created_at=now_iso(), modified_at="2026-01-01",
                                color_rules=[_color_rule("Urgent")])
        self.db.add_all([pa, pb])
        self.db.commit()
        self.arm()
        out = R.rename_label(R.RenameBody(name="Urgent", to="Critical"), user=AMGR, db=self.db)
        self.assertEqual(out["also"]["projects"], 1)
        pa, pb = self.get(models.TaskProject, pa.id), self.get(models.TaskProject, pb.id)
        self.assertEqual([r["conditions"][0]["value"] for r in pa.color_rules], ["Critical", "other"])
        self.assertGreater(pa.modified_at, "2026-01-01")
        self.assertEqual(pb.color_rules[0]["conditions"][0]["value"], "Urgent")

    def test_my_tasks_row_colors_and_saved_views_follow_for_people_in_the_company(self):
        self.task(COA, tags=["Urgent"])
        mine = {"rowColors": {"data": {"mine": [_color_rule("urgent")], "hidden": False}}, "richlist": {"order": ["task"]}}
        a = models.TaskTablePref(id=gen_id(), owner_email=AEMP["email"], prefs=mine)
        b = models.TaskTablePref(id=gen_id(), owner_email=BEMP["email"], prefs=json_copy(mine))
        va = models.TaskSavedView(id=gen_id(), owner_email=AEMP["email"], name="V", view="list",
                                  filters={"tags": ["urgent", "client"], "statuses": []}, scope="task")
        vb = models.TaskSavedView(id=gen_id(), owner_email=BEMP["email"], name="V", view="list",
                                  filters={"tags": ["Urgent"]}, scope="task")
        self.db.add_all([a, b, va, vb])
        self.db.commit()
        self.arm()
        out = R.rename_label(R.RenameBody(name="Urgent", to="Critical"), user=AMGR, db=self.db)
        self.assertEqual((out["also"]["personalRules"], out["also"]["savedViews"]), (1, 1))
        a, b = self.get(models.TaskTablePref, a.id), self.get(models.TaskTablePref, b.id)
        self.assertEqual(a.prefs["rowColors"]["data"]["mine"][0]["conditions"][0]["value"], "Critical")
        self.assertEqual(a.prefs["richlist"], {"order": ["task"]})   # the rest of the document is kept
        self.assertEqual(b.prefs["rowColors"]["data"]["mine"][0]["conditions"][0]["value"], "urgent")
        self.assertEqual(self.get(models.TaskSavedView, va.id).filters, {"tags": ["critical", "client"], "statuses": []})
        self.assertEqual(self.get(models.TaskSavedView, vb.id).filters, {"tags": ["Urgent"]})
        # A delete takes the label out of the filter.
        R.delete_label(R.DeleteBody(name="Critical"), user=AMGR, db=self.db)
        self.assertEqual(self.get(models.TaskSavedView, va.id).filters["tags"], ["client"])

    def test_templates_are_counted_not_changed_and_impact_says_so(self):
        self.task(tags=["Urgent"], deleted_at=now_iso())
        self.task(tags=["urgent"])
        tpl = models.TaskTemplate(id=gen_id(), name="T", patch={"tags": ["Urgent"]}, created_at=now_iso())
        self.db.add(tpl)
        self.rule(conditions=[{"field": "tag", "op": "is", "value": "urgent"}],
                  actions=[{"type": "add_tag", "value": "Urgent"}])
        self.db.commit()
        got = R.label_impact(name="URGENT", company="", user=AMGR, db=self.db)
        self.assertEqual((got["tasks"], got["templates"], got["automationRules"]), (2, 1, 1))
        self.assertEqual(got["deleteRules"], {"automationRules": 1, "rulesDisabled": 1, "rulesStillNaming": 1})
        R.rename_label(R.RenameBody(name="Urgent", to="Hot"), user=AMGR, db=self.db)
        self.assertEqual(self.get(models.TaskTemplate, tpl.id).patch, {"tags": ["Urgent"]})
        # A dry run changed nothing before the rename did.
        self.assertEqual(self.db.query(models.TaskAutomationRule).one().actions[0]["value"], "Hot")


class AutomationKeyTests(Base):
    def test_a_tag_condition_matches_spacing_and_case_variants(self):
        t = self.task(tags=["Q4   Close"])
        snap = task_automation.snapshot(t)
        self.assertTrue(task_automation.conditions_ok([{"field": "tag", "op": "is", "value": " q4 close"}], snap))
        self.assertFalse(task_automation.conditions_ok([{"field": "tag", "op": "is_not", "value": "Q4 CLOSE"}], snap))

    def test_add_tag_does_not_add_a_spacing_variant_twice(self):
        t = self.task(tags=["Q4 Close"])
        res = task_automation.Result()
        line = task_automation._apply_action(self.db, t, {"type": "add_tag", "value": "q4   close"}, res,
                                             today=None, gate=None, prev_status="", prev_completed=False)
        self.assertEqual((line, t.tags), ("", ["Q4 Close"]))


def json_copy(v):
    import json
    return json.loads(json.dumps(v))


if __name__ == "__main__":
    unittest.main()
