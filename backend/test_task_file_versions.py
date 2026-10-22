"""Task file versions and Egnyte links (Neil, Oct 22 2026).

- Upload New Version: numbered 1, 2, 3... per file; the list shows only the
  current version; older ones stay. Removing the current version hands the
  file back to the one before; Delete All Versions removes the file.
- Rights are the attachment rights exactly: adding a version = adding a file
  (commenter), removing = the uploader or an editor; walls and restricted
  tasks hold.
- Egnyte links: https on the company Egnyte host only (lookalikes, other
  schemes and user@host refused), stored as kind "egnyte", never touching
  storage, never versioned; an uploaded file cannot pose as one.

Throwaway SQLite, no network.  python -m pytest test_task_file_versions.py
"""
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException

import cache
import database
import models
from routers import tasks as T
from routers import tickets as TK
from routers.task_util import gen_id, now_iso


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

OWNER = {"email": "owner@greensglobal.com", "level": 1}
COMMENTER = {"email": "commenter@greensglobal.com", "level": 1}
VIEWER = {"email": "viewer@greensglobal.com", "level": 1}
EDITOR = {"email": "editor@greensglobal.com", "level": 1}
OUTSIDER = {"email": "outsider@greensglobal.com", "level": 1}
AMGR = {"email": "amgr@greensglobal.com", "level": 3}
COA, COB = "co-a", "co-b"
EGNYTE = {"EGNYTE_DOMAIN": "greens.egnyte.com"}


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
        for m in (models.Task, models.TaskProject, models.TaskComment, models.TaskAttachment,
                  models.TaskActivity, models.TaskNotification, models.NexusNotification,
                  models.NexusEmployee, models.NexusSetting, models.TaskTicket):
            self.db.query(m).execution_options(include_deleted=True).delete()
        for u, co in ((OWNER, COA), (COMMENTER, COA), (VIEWER, COA), (EDITOR, COA), (OUTSIDER, COA),
                      (AMGR, COA), ({"email": "b@greensglobal.com"}, COB)):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=u["email"], status="active",
                                             first_name=u["email"].split("@")[0], company=co))
        self.db.commit()
        cache.settings_config.invalidate()
        self.project = models.TaskProject(
            id=gen_id(), name="Plans", access_level="restricted", owner_email=OWNER["email"],
            member_roles={COMMENTER["email"]: "commenter", VIEWER["email"]: "viewer",
                          EDITOR["email"]: "editor"},
            created_at=now_iso(), company_id=COA)
        self.db.add(self.project)
        self.db.commit()
        self.t = self.task()

    def tearDown(self):
        self.db.close()
        cache.settings_config.invalidate()

    def task(self, **kw):
        kw.setdefault("project_id", self.project.id)
        kw.setdefault("company_id", COA)
        t = models.Task(id=gen_id(), title="Pump", code=f"T-{gen_id()[:6]}", status="not_started",
                        attachment_ids=[], activity_ids=[], created_at=now_iso(), modified_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def code(self, call):
        with self.assertRaises(HTTPException) as e:
            call()
        self.db.rollback()
        return e.exception.status_code

    def attach(self, user=OWNER, name="plan.pdf", t=None, **kw):
        return T.add_attachment((t or self.t).id, T.AttachmentCreate(name=name, url="data:x", **kw),
                                user=user, db=self.db)

    def version(self, aid, user=OWNER, name="plan.pdf", **kw):
        kw.setdefault("url", "data:y")
        return T.add_attachment_version(aid, T.AttachmentVersionCreate(name=name, **kw), user=user, db=self.db)

    def listed(self, user=OWNER, t=None):
        return T.list_attachments((t or self.t).id, user=user, db=self.db)

    def arm_walls(self):
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()

    def task_row(self):
        self.db.expire_all()
        return self.db.get(models.Task, self.t.id)

    def details(self):
        return [a.detail for a in self.db.query(models.TaskActivity).order_by(models.TaskActivity.at).all()]


class VersionTests(Base):
    def test_versions_number_up_and_the_list_shows_only_the_latest(self):
        a = self.attach()
        v2 = self.version(a["id"], name="plan-rev.pdf")
        v3 = self.version(v2["id"])     # from any version of the file
        self.assertEqual((v2["version"], v3["version"]), (2, 3))
        self.assertEqual(v3["versionGroup"], a["id"])
        rows = self.listed()
        self.assertEqual([(r["id"], r["version"], r["versionCount"]) for r in rows], [(v3["id"], 3, 3)])
        all_v = T.list_attachment_versions(a["id"], user=OWNER, db=self.db)
        self.assertEqual([r["version"] for r in all_v], [3, 2, 1])
        self.assertEqual(self.task_row().attachment_ids, [v3["id"]])     # files, not uploads
        self.assertIn('uploaded version 3 of "plan-rev.pdf"', self.details())

    def test_an_older_row_is_version_one_of_its_own_group(self):
        old = models.TaskAttachment(id=gen_id(), task_id=self.t.id, name="old.png", kind="image",
                                    url="data:x", added_at="2026-01-01T00:00:00", added_by=OWNER["email"])
        self.db.add(old)
        self.db.commit()
        r = self.listed()[0]
        self.assertEqual((r["version"], r["versionGroup"], r["versionCount"]), (1, old.id, 1))

    def test_the_list_keeps_a_files_place_when_it_gets_a_new_version(self):
        a = self.attach(name="a.pdf")
        b = self.attach(name="b.pdf")
        self.version(a["id"], name="a2.pdf")
        self.assertEqual([r["name"] for r in self.listed()], ["a2.pdf", "b.pdf"])
        self.assertEqual(len(self.task_row().attachment_ids), 2)
        self.assertIn(b["id"], self.task_row().attachment_ids)

    def test_removing_the_current_version_promotes_the_previous(self):
        a = self.attach()
        v2 = self.version(a["id"])
        T.delete_attachment(v2["id"], user=OWNER, db=self.db)
        rows = self.listed()
        self.assertEqual([(r["id"], r["version"], r["versionCount"]) for r in rows], [(a["id"], 1, 1)])
        self.assertEqual(self.task_row().attachment_ids, [a["id"]])
        self.assertIn('removed version 2 of "plan.pdf"', self.details())
        # And numbering picks up from what is left.
        self.assertEqual(self.version(a["id"])["version"], 2)

    def test_removing_an_older_version_leaves_the_current_one(self):
        a = self.attach()
        v2 = self.version(a["id"])
        T.delete_attachment(a["id"], user=OWNER, db=self.db)
        self.assertEqual([r["id"] for r in self.listed()], [v2["id"]])
        self.assertEqual(self.task_row().attachment_ids, [v2["id"]])
        self.assertEqual(self.version(v2["id"])["version"], 3)

    def test_delete_all_versions_removes_the_whole_file(self):
        a = self.attach()
        keep = self.attach(name="keep.pdf")
        self.version(a["id"])
        v3 = self.version(a["id"])
        T.delete_attachment_versions(v3["id"], user=OWNER, db=self.db)
        self.assertEqual([r["id"] for r in self.listed()], [keep["id"]])
        self.assertEqual(self.db.query(models.TaskAttachment).count(), 1)
        self.assertEqual(self.task_row().attachment_ids, [keep["id"]])
        self.assertIn('removed "plan.pdf" and all 3 versions', self.details())

    def test_comment_files_and_egnyte_links_take_no_versions(self):
        c = models.TaskComment(id=gen_id(), task_id=self.t.id, author_email=OWNER["email"], body="x",
                               created_at=now_iso())
        self.db.add(c)
        self.db.commit()
        cf = self.attach(comment_id=c.id)
        self.assertEqual(self.code(lambda: self.version(cf["id"])), 422)
        with mock.patch.dict(os.environ, EGNYTE):
            e = T.add_egnyte_link(self.t.id, T.EgnyteLinkCreate(url="https://greens.egnyte.com/navigate/file/g1",
                                                                name="lease.pdf", is_folder=False),
                                  user=OWNER, db=self.db)
        self.assertEqual(self.code(lambda: self.version(e["id"])), 422)

    def test_a_new_version_url_obeys_the_attachment_url_rule(self):
        a = self.attach()
        for bad in ("javascript:alert(1)", "https://evil.example.com/x.pdf"):
            import routers.items as items
            with mock.patch.object(items, "_STORAGE_PREFIX", "https://proj.supabase.co/storage/v1/object/public/"):
                self.assertEqual(self.code(lambda u=bad: self.version(a["id"], url=u)), 400, bad)
        self.assertEqual(self.code(lambda: self.version(a["id"], kind="egnyte")), 422)

    def test_a_ticket_conversion_copies_current_versions_and_no_links(self):
        a = self.attach()
        self.version(a["id"], name="plan-v2.pdf")
        with mock.patch.dict(os.environ, EGNYTE):
            T.add_egnyte_link(self.t.id, T.EgnyteLinkCreate(url="https://greens.egnyte.com/navigate/file/g1"),
                              user=OWNER, db=self.db)
        tk = models.TaskTicket(id=gen_id(), code="TK-1", subject="S", created_at=now_iso())
        self.db.add(tk)
        self.db.commit()
        TK._copy_task_files(self.db, self.t, tk, OWNER["email"])
        self.db.commit()
        names = [r.name for r in self.db.query(models.TaskAttachment).filter_by(task_id=tk.id).all()]
        self.assertEqual(names, ["plan-v2.pdf"])


class VersionPermissionTests(Base):
    def test_a_commenter_adds_versions_a_viewer_cannot(self):
        a = self.attach()
        self.assertEqual(self.version(a["id"], user=COMMENTER)["version"], 2)
        self.assertEqual(self.code(lambda: self.version(a["id"], user=VIEWER)), 403)
        self.assertEqual(self.code(lambda: self.version(a["id"], user=OUTSIDER)), 403)

    def test_removing_matches_the_attachment_rule(self):
        a = self.attach()
        v2 = self.version(a["id"], user=COMMENTER)
        # The commenter uploaded v2 - theirs to remove; the owner's v1 is not.
        self.assertEqual(self.code(lambda: T.delete_attachment(a["id"], user=COMMENTER, db=self.db)), 403)
        T.delete_attachment(v2["id"], user=COMMENTER, db=self.db)
        self.assertEqual(self.listed()[0]["id"], a["id"])

    def test_delete_all_needs_every_version_yours_or_an_editor(self):
        a = self.attach(user=COMMENTER)
        self.version(a["id"], user=OWNER)
        self.assertEqual(self.code(lambda: T.delete_attachment_versions(a["id"], user=COMMENTER, db=self.db)), 403)
        self.assertEqual(self.code(lambda: T.delete_attachment_versions(a["id"], user=VIEWER, db=self.db)), 403)
        self.assertEqual(self.db.query(models.TaskAttachment).count(), 2)
        T.delete_attachment_versions(a["id"], user=EDITOR, db=self.db)
        self.assertEqual(self.db.query(models.TaskAttachment).count(), 0)

    def test_all_mine_is_enough_to_delete_all(self):
        a = self.attach(user=COMMENTER)
        self.version(a["id"], user=COMMENTER)
        T.delete_attachment_versions(a["id"], user=COMMENTER, db=self.db)
        self.assertEqual(self.db.query(models.TaskAttachment).count(), 0)

    def test_a_restricted_task_stays_hidden(self):
        secret = self.task(project_id="", access_level="restricted", owner_email=OWNER["email"],
                           created_by=OWNER["email"])
        a = self.attach(t=secret)
        self.assertEqual(self.code(lambda: self.version(a["id"], user=OUTSIDER)), 404)
        self.assertEqual(self.code(lambda: T.list_attachment_versions(a["id"], user=OUTSIDER, db=self.db)), 404)
        self.assertEqual(self.code(lambda: T.delete_attachment_versions(a["id"], user=OUTSIDER, db=self.db)), 404)
        with mock.patch.dict(os.environ, EGNYTE):
            self.assertEqual(self.code(lambda: T.add_egnyte_link(
                secret.id, T.EgnyteLinkCreate(url="https://greens.egnyte.com/fl/x"), user=OUTSIDER, db=self.db)), 404)

    def test_the_company_wall_holds_for_a_manager(self):
        b_task = self.task(project_id="", company_id=COB, access_level="org")
        a = self.attach(t=b_task, user=AMGR)
        self.arm_walls()
        self.assertEqual(self.code(lambda: self.version(a["id"], user=AMGR)), 404)
        self.assertEqual(self.code(lambda: T.list_attachment_versions(a["id"], user=AMGR, db=self.db)), 404)
        self.assertEqual(self.code(lambda: T.delete_attachment_versions(a["id"], user=AMGR, db=self.db)), 404)
        with mock.patch.dict(os.environ, EGNYTE):
            self.assertEqual(self.code(lambda: T.add_egnyte_link(
                b_task.id, T.EgnyteLinkCreate(url="https://greens.egnyte.com/fl/x"), user=AMGR, db=self.db)), 404)
        self.assertEqual(self.db.query(models.TaskAttachment).count(), 1)

    def test_a_ticket_file_is_not_a_task_file(self):
        a = models.TaskAttachment(id=gen_id(), task_id="ticket-1", name="x.png", url="data:x",
                                  added_by=OWNER["email"])
        self.db.add(a)
        self.db.commit()
        self.assertEqual(self.code(lambda: self.version(a.id, user=AMGR)), 404)


class EgnyteLinkTests(Base):
    def add(self, url, user=OWNER, **kw):
        with mock.patch.dict(os.environ, EGNYTE):
            return T.add_egnyte_link(self.t.id, T.EgnyteLinkCreate(url=url, **kw), user=user, db=self.db)

    def test_a_link_on_the_company_egnyte_is_stored_as_a_link(self):
        with mock.patch.object(T, "data_url_to_storage") as store:
            r = self.add("https://greens.egnyte.com/app/index.do#storage/files/1/Shared/Leases/Temecula%20Lease")
        store.assert_not_called()
        self.assertEqual((r["kind"], r["egnyteKind"], r["egnytePath"], r["name"]),
                         ("egnyte", "folder", "/Shared/Leases/Temecula Lease", "Temecula Lease"))
        self.assertFalse(r["size"])
        self.assertTrue(r["url"].startswith("https://greens.egnyte.com/"))
        self.assertIn(r["id"], self.task_row().attachment_ids)
        self.assertIn('linked Egnyte folder "Temecula Lease"', self.details())

    def test_a_picked_file_keeps_its_name_and_path(self):
        r = self.add("https://GREENS.egnyte.com/navigate/file/abc", name="lease.pdf",
                     path="/Shared/Leases/lease.pdf", is_folder=False)
        self.assertEqual((r["egnyteKind"], r["egnytePath"], r["name"]), ("file", "/Shared/Leases/lease.pdf", "lease.pdf"))

    def test_other_hosts_lookalikes_and_schemes_are_refused(self):
        bad = (
            "https://egnyte.com.evil.com/fl/x", "https://greens.egnyte.com.evil.com/fl/x",
            "https://evil.com/greens.egnyte.com", "https://greens.egnyte.com@evil.com/fl/x",
            "https://user@greens.egnyte.com/fl/x", "https://evilgreens.egnyte.com/fl/x",
            "https://other.egnyte.com/fl/x", "http://greens.egnyte.com/fl/x",
            "https://greens.egnyte.com:8443/fl/x", "javascript:alert(1)", "JavaScript://greens.egnyte.com/%0aalert(1)",
            "data:text/html,<script>1</script>", "//greens.egnyte.com/fl/x", "greens.egnyte.com/fl/x",
            "https://greens.egnyte.com/fl/x y", "", "   ",
        )
        for url in bad:
            self.assertEqual(self.code(lambda u=url: self.add(u)), 400, url)
        self.assertEqual(self.db.query(models.TaskAttachment).count(), 0)

    def test_a_path_that_is_not_an_egnyte_path_is_not_shown(self):
        r = self.add("https://greens.egnyte.com/fl/abc", path="C:/Windows", is_folder=False)
        self.assertFalse(r["egnytePath"])

    def test_without_egnyte_set_up_nothing_is_taken(self):
        with mock.patch.dict(os.environ, {"EGNYTE_DOMAIN": ""}):
            self.assertEqual(self.code(lambda: T.add_egnyte_link(
                self.t.id, T.EgnyteLinkCreate(url="https://greens.egnyte.com/fl/x"), user=OWNER, db=self.db)), 400)

    def test_a_bare_tenant_domain_means_its_egnyte_host(self):
        with mock.patch.dict(os.environ, {"EGNYTE_DOMAIN": "greens"}):
            r = T.add_egnyte_link(self.t.id, T.EgnyteLinkCreate(url="https://greens.egnyte.com/fl/x"),
                                  user=OWNER, db=self.db)
        self.assertEqual(r["kind"], "egnyte")

    def test_link_rights_are_the_attachment_rights(self):
        self.assertEqual(self.add("https://greens.egnyte.com/fl/x", user=COMMENTER)["kind"], "egnyte")
        self.assertEqual(self.code(lambda: self.add("https://greens.egnyte.com/fl/y", user=VIEWER)), 403)
        r = self.add("https://greens.egnyte.com/fl/z", user=COMMENTER)
        # Removed like any file: the one who added it, or an editor.
        self.assertEqual(self.code(lambda: T.delete_attachment(r["id"], user=VIEWER, db=self.db)), 403)
        T.delete_attachment(r["id"], user=COMMENTER, db=self.db)
        self.assertEqual(len(self.listed()), 1)

    def test_an_uploaded_file_cannot_pose_as_an_egnyte_link(self):
        for kind in ("egnyte", "Egnyte", " egnyte "):
            self.assertEqual(self.code(lambda k=kind: self.attach(kind=k)), 422, kind)

    def test_the_normal_attachment_rule_is_not_loosened(self):
        import routers.items as items
        with mock.patch.dict(os.environ, EGNYTE), \
                mock.patch.object(items, "_STORAGE_PREFIX", "https://proj.supabase.co/storage/v1/object/public/"):
            self.assertEqual(self.code(lambda: T.add_attachment(
                self.t.id, T.AttachmentCreate(name="x", url="https://greens.egnyte.com/fl/x"),
                user=OWNER, db=self.db)), 400)

    def test_status_reports_the_company_host(self):
        from routers import egnyte as E
        with mock.patch.dict(os.environ, {"EGNYTE_DOMAIN": "greens"}):
            self.assertEqual(E.status(user=OWNER)["webHost"], "greens.egnyte.com")
        with mock.patch.dict(os.environ, {"EGNYTE_DOMAIN": ""}):
            self.assertEqual(E.status(user=OWNER)["webHost"], "")


if __name__ == "__main__":
    unittest.main()
