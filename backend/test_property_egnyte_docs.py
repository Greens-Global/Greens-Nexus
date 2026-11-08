"""Plans & Docs from an asset's connected Egnyte folder (Neil, 11/05/2026:
"nobody is lost in Egnyte to see the docs").

  * anyone who may SEE the asset (viewers included) lists and opens the files
    in its connected folder - read with the shared service token, so their
    own Egnyte access does not matter;
  * every path must sit inside the pinned folder ('..' refused, case-blind);
  * an asset outside the caller's reach is 404; nothing pinned = connected false;
  * a pinned folder Egnyte no longer has is `missing`, not an error;
  * connecting is ONE TIME: an editor connects an unpinned asset, only an
    Asset Management Owner (grant) or a Super Administrator changes it.

Throwaway sqlite file; Egnyte is mocked, never called.
Run with: python -m pytest test_property_egnyte_docs.py   (one file per process)
"""
import os
import tempfile
import unittest
import uuid
from unittest import mock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ.pop("SUPABASE_URL", None)
for _v in ("EGNYTE_PROPERTIES_ROOTS", "EGNYTE_PROPERTIES_ROOT", "EGNYTE_CREATE_ROOT"):
    os.environ.pop(_v, None)

from fastapi import HTTPException  # noqa: E402

import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from routers import property_assets as PA  # noqa: E402
from services import egnyte as egnyte_svc  # noqa: E402

PINNED = "/Shared/--Asset Management/GS Escondido"
EGNYTE_ON = {"EGNYTE_DOMAIN": "greens.egnyte.com", "EGNYTE_TOKEN": "t"}
VIEWER = {"email": "v@greensglobal.com", "role": "employee", "level": 1}
EDITOR = {"email": "ed@greensglobal.com", "role": "employee", "level": 2}
OWNER_GRANT = {"email": "own@greensglobal.com", "role": "employee", "level": 2}
SUPER = {"email": "neil@greensglobal.com", "role": "owner", "level": 5}


def _listing(path, token=None, **kw):
    p = egnyte_svc.norm(path)
    if p.lower() not in (PINNED.lower(), f"{PINNED}/Plans".lower()):
        raise egnyte_svc.EgnyteError("not found", 404)
    return {"path": p, "folders": [{"name": "Plans", "path": f"{PINNED}/Plans"}],
            "files": [{"name": "CO.pdf", "path": f"{p}/CO.pdf", "groupId": "g1", "size": 3}]}


class DocsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp.name)
        except OSError:
            pass

    def setUp(self):
        cache.egnyte_wirings.invalidate()
        cache.module_grants.invalidate()
        self.db = database.SessionLocal()
        for M in (models.PropertyAsset, models.PropertyRecord, models.PropertyActivityLog,
                  models.PropertyWorkspaceMeta, models.NexusAccessScope, models.NexusGroup, models.NexusGroupMember):
            self.db.query(M).delete()
        self.db.add(models.PropertyAsset(id="esc", name="Escondido", updated_at="r0",
                                         payload={"id": "esc", "name": "Escondido", "egnyteFolder": PINNED}))
        self.db.add(models.PropertyAsset(id="bare", name="Bare", updated_at="r0", payload={"id": "bare", "name": "Bare"}))
        self.db.add(models.NexusGroup(id="g-own", name="Asset Owners", allowed_modules="property-asset:owner"))
        self.db.add(models.NexusGroupMember(group_id="g-own", email=OWNER_GRANT["email"]))
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _folder(self, user, pid="esc", path=""):
        with mock.patch.dict(os.environ, EGNYTE_ON), mock.patch.object(egnyte_svc, "list_folder", side_effect=_listing) as lf:
            out = PA.asset_egnyte_folder(pid, path=path, db=self.db, user=user)
        return out, lf

    # ── reading ──────────────────────────────────────────────────────────
    def test_a_viewer_lists_the_connected_folder_with_the_service_token(self):
        out, lf = self._folder(VIEWER)
        self.assertTrue(out["connected"])
        self.assertEqual([f["name"] for f in out["files"]], ["CO.pdf"])
        self.assertFalse(out["mayChange"])
        self.assertNotIn("token", lf.call_args.kwargs)   # shared token, never the viewer's own

    def test_a_subfolder_inside_opens_and_case_does_not_matter(self):
        out, _ = self._folder(VIEWER, path=f"{PINNED.lower()}/plans")
        self.assertEqual(out["files"][0]["name"], "CO.pdf")

    def test_paths_outside_the_folder_are_refused(self):
        for bad in ("/Shared/HR", f"{PINNED}/../HR", f"{PINNED} Other", "/Shared/--Asset Management"):
            with self.subTest(bad=bad), self.assertRaises(HTTPException) as e:
                self._folder(VIEWER, path=bad)
            self.assertEqual(e.exception.status_code, 403)

    def test_nothing_pinned_is_not_connected(self):
        out, lf = self._folder(VIEWER, pid="bare")
        self.assertFalse(out["connected"])
        lf.assert_not_called()

    def test_a_missing_pinned_folder_says_so(self):
        with mock.patch.dict(os.environ, EGNYTE_ON), \
             mock.patch.object(egnyte_svc, "list_folder", side_effect=egnyte_svc.EgnyteError("nf", 404)):
            out = PA.asset_egnyte_folder("esc", path="", db=self.db, user=VIEWER)
        self.assertTrue(out["missing"])

    def test_egnyte_down_is_an_answer_not_a_5xx(self):
        with mock.patch.dict(os.environ, EGNYTE_ON), \
             mock.patch.object(egnyte_svc, "list_folder", side_effect=egnyte_svc.EgnyteError("boom", 500)):
            out = PA.asset_egnyte_folder("esc", path="", db=self.db, user=VIEWER)
        self.assertIn("did not answer", out["error"])

    def test_outside_reach_is_404(self):
        self.db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=VIEWER["email"], module_id="property-asset",
                                            scope_type="property", scope_id="bare"))
        self.db.commit()
        with self.assertRaises(HTTPException) as e:
            self._folder(VIEWER)
        self.assertEqual(e.exception.status_code, 404)

    def test_a_file_inside_downloads_and_html_never_renders_inline(self):
        with mock.patch.dict(os.environ, EGNYTE_ON), mock.patch.object(egnyte_svc, "read_file", return_value=b"x"):
            pdf = PA.asset_egnyte_file("esc", path=f"{PINNED}/CO.pdf", inline=True, db=self.db, user=VIEWER)
            html = PA.asset_egnyte_file("esc", path=f"{PINNED}/Plans/évil \"x\".html", inline=True, db=self.db, user=VIEWER)
        self.assertEqual(pdf.media_type, "application/pdf")
        self.assertEqual(html.media_type, "application/octet-stream")
        self.assertTrue(html.headers["content-disposition"].startswith("attachment; filename*=UTF-8''"))

    def test_a_file_outside_or_the_folder_itself_is_refused(self):
        for bad in ("/Shared/HR/pay.pdf", f"{PINNED}/../HR/pay.pdf", PINNED):
            with self.subTest(bad=bad), self.assertRaises(HTTPException) as e, \
                 mock.patch.dict(os.environ, EGNYTE_ON), mock.patch.object(egnyte_svc, "read_file", return_value=b"x"):
                PA.asset_egnyte_file("esc", path=bad, db=self.db, user=VIEWER)
            self.assertEqual(e.exception.status_code, 403)

    def test_the_docs_routes_are_open_to_viewers(self):
        def deps(path):
            route = next(r for r in PA.router.routes if r.path == path)
            return [d.call for d in route.dependant.dependencies]
        self.assertIn(PA.require_asset_read, deps("/property-assets/{pid}/egnyte/folder"))
        self.assertIn(PA.require_asset_read, deps("/property-assets/{pid}/egnyte/file"))

    # ── the one-time connection ──────────────────────────────────────────
    def _save(self, user, pid, folder):
        from routers.property_assets import Changes
        ch = Changes(**{"properties": {"upsert": [{"id": pid, "name": pid.title(), "_rev": "r0", "egnyteFolder": folder}]}})
        out = PA.post_changes(ch, db=self.db, user=user)
        self.db.expire_all()
        return out

    def _pin(self, pid):
        return (self.db.get(models.PropertyAsset, pid).payload or {}).get("egnyteFolder")

    def test_an_editor_connects_once_but_cannot_change_it(self):
        out = self._save(EDITOR, "bare", f"{PINNED} North")
        self.assertEqual(out["refused"], [])
        out = self._save(EDITOR, "esc", f"{PINNED} North")
        self.assertEqual([(r["id"], r["status"]) for r in out["refused"]], [("esc", 403)])
        self.assertIn("Owner", out["refused"][0]["message"])
        self.assertEqual(self._pin("esc"), PINNED)

    def test_an_owner_grant_or_a_super_administrator_may_change_it(self):
        self.assertTrue(PA.may_repin_egnyte(self.db, OWNER_GRANT))
        self.assertTrue(PA.may_repin_egnyte(self.db, SUPER))
        self.assertFalse(PA.may_repin_egnyte(self.db, EDITOR))
        self.assertFalse(PA.may_repin_egnyte(self.db, {"email": "a@greensglobal.com", "role": "administrator", "level": 4}))
        out = self._save(OWNER_GRANT, "esc", f"{PINNED} North")
        self.assertEqual(out["refused"], [])
        self.assertEqual(self._pin("esc"), f"{PINNED} North")


if __name__ == "__main__":
    unittest.main()
