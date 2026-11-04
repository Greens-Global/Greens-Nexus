"""Construction files go to the PROPERTY's Egnyte folder (Neil, 11/03/2026).

Until 11/03/2026 the sweep looked a job's property up in `models.Property`,
which does not exist, so every photo, video and voice note since August went
to the construction root. Now a job with a property files under
`<property folder>/Construction/<code - job>/Daily Logs/YYYY-MM/YYYY-MM-DD/`;
a job without one, or whose property has no single sure Egnyte folder, keeps
the root (logged). Files already at the root stay there: the report lists
them, nothing moves.

Run with: python -m pytest test_construction_egnyte_property_folder.py
"""
import os
import re
import tempfile
import unittest
from unittest import mock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["EGNYTE_CONSTRUCTION_ROOT"] = "/Shared/Construction"

import database  # noqa: E402
import models  # noqa: E402
import construction_worker as worker  # noqa: E402
from services import construction_storage as storage  # noqa: E402
from services import egnyte as egnyte_svc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PROP_FOLDER = "/Shared/#Entities/Greens Valley Center, LLC"
ROOT = "/Shared/Construction"
SEG = "GSVC-2026-04 - Phase 2 Canopy"
FOUND = (PROP_FOLDER, "matched")
MANAGER = {"email": "m@greensglobal.com", "level": 3}
EGNYTE_ON = {"EGNYTE_DOMAIN": "greens.egnyte.com", "EGNYTE_TOKEN": "t"}


def _iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


class _Resp:
    content = b"jpeg-bytes"

    def raise_for_status(self):
        pass


class _Client:
    def __init__(self, *a, **k):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url):
        return _Resp()


def _forbidden(*a, **k):
    raise AssertionError("nothing may be moved, copied or deleted in Egnyte")


class PropertyFolderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp.name)

    def setUp(self):
        worker._FOLDER_MEMO.clear()
        self.db = database.SessionLocal()
        for M in (models.ConstructionMedia, models.ConstructionDailyLog,
                  models.ConstructionProject, models.ConstructionAIJob, models.PropertyAsset):
            self.db.query(M).delete()
        self.db.add(models.PropertyAsset(id="greens-valley-center", name="Valley Center"))
        self.db.add(models.PropertyAsset(id="secret", name="Hidden Ranch", payload={"private": True}))
        self.db.add(models.ConstructionProject(id="p1", name="Phase 2 / Canopy", code="GSVC-2026-04",
                                               property_id="greens-valley-center", created_at=_iso()))
        self.db.add(models.ConstructionProject(id="p2", name="Yard Fence", created_at=_iso()))
        self.db.add(models.ConstructionProject(id="p3", name="Gone", property_id="not-in-asset-mgmt",
                                               created_at=_iso()))
        self.db.add(models.ConstructionProject(id="p4abcdef-1234", name="Barn Roof", property_id="secret",
                                               created_at=_iso()))
        self.db.add(models.ConstructionDailyLog(id="l1", project_id="p1", log_date="2026-08-04",
                                                author_email="w@greensglobal.com", status="submitted"))
        self.db.add(models.ConstructionDailyLog(id="ld", project_id="p1", log_date="2026-08-05",
                                                author_email="w@greensglobal.com", status="draft"))
        self.db.commit()
        self.p1 = self.db.get(models.ConstructionProject, "p1")
        self.p2 = self.db.get(models.ConstructionProject, "p2")
        self.p3 = self.db.get(models.ConstructionProject, "p3")
        self.p4 = self.db.get(models.ConstructionProject, "p4abcdef-1234")

    def tearDown(self):
        self.db.close()

    # ── the path ─────────────────────────────────────────────────────────────
    def test_a_property_job_files_under_the_propertys_own_folder(self):
        with mock.patch.object(egnyte_svc, "find_property_folder", return_value=FOUND) as r:
            folder = worker.media_folder(self.db, self.p1, "2026-08-04")
        self.assertEqual(folder, f"{PROP_FOLDER}/Construction/{SEG}/Daily Logs/2026-08/2026-08-04")
        r.assert_called_once_with("Valley Center")   # the Asset Management property's name

    def test_no_folder_for_the_property_falls_back_to_the_construction_root(self):
        with mock.patch.object(egnyte_svc, "find_property_folder", return_value=(None, "no_match")):
            folder = worker.media_folder(self.db, self.p1, "2026-08-04")
        self.assertEqual(folder, f"{ROOT}/Phase 2 / Canopy/Construction/Daily Logs/2026-08/2026-08-04")
        self.assertEqual(worker.property_folder(self.db, self.p1), ("", "no_egnyte_folder"))

    def test_an_ambiguous_match_falls_back_to_the_root(self):
        with mock.patch.object(egnyte_svc, "find_property_folder", return_value=(None, "ambiguous")):
            folder = worker.media_folder(self.db, self.p1, "2026-08-04")
            self.assertEqual(worker.property_folder(self.db, self.p1), ("", "ambiguous"))
        self.assertTrue(folder.startswith(f"{ROOT}/"))

    def test_a_job_without_a_property_keeps_the_root_and_never_searches(self):
        with mock.patch.object(egnyte_svc, "find_property_folder") as r:
            folder = worker.media_folder(self.db, self.p2, "2026-08-04")
        self.assertEqual(folder, f"{ROOT}/Yard Fence/Construction/Daily Logs/2026-08/2026-08-04")
        r.assert_not_called()

    def test_a_property_missing_from_asset_management_keeps_the_root(self):
        with mock.patch.object(egnyte_svc, "find_property_folder") as r:
            folder = worker.media_folder(self.db, self.p3, "2026-08-04")
        self.assertTrue(folder.startswith(f"{ROOT}/Gone/"))
        r.assert_not_called()
        self.assertEqual(worker.property_folder(self.db, self.p3)[1], "property_missing")

    def test_egnyte_not_answering_raises_and_is_not_relisted_this_tick(self):
        boom = egnyte_svc.EgnyteError("upstream", 502)
        with mock.patch.object(egnyte_svc, "find_property_folder", side_effect=boom) as r:
            for _ in range(3):
                with self.assertRaises(egnyte_svc.EgnyteError):
                    worker.media_folder(self.db, self.p1, "2026-08-04")
        self.assertEqual(r.call_count, 1)

    def test_one_lookup_per_property_per_tick(self):
        with mock.patch.object(egnyte_svc, "find_property_folder", return_value=FOUND) as r:
            worker.media_folder(self.db, self.p1, "2026-08-04")
            worker.media_folder(self.db, self.p1, "2026-08-05")
        self.assertEqual(r.call_count, 1)

    def test_a_renamed_job_keeps_the_folder_its_files_went_to(self):
        self._uploaded("old", "p1", f"{PROP_FOLDER}/Construction/{SEG}/Daily Logs/2026-08/2026-08-04/a.jpg")
        self.p1.name, self.p1.code = "Canopy Rebuild", "GSVC-2026-09"
        self.db.commit()
        with mock.patch.object(egnyte_svc, "find_property_folder", return_value=FOUND):
            folder = worker.media_folder(self.db, self.p1, "2026-09-01")
        self.assertEqual(folder, f"{PROP_FOLDER}/Construction/{SEG}/Daily Logs/2026-09/2026-09-01")

    def test_the_models_property_bug_is_gone(self):
        self.assertFalse(hasattr(models, "Property"))
        with open(os.path.join(HERE, "construction_worker.py"), encoding="utf-8") as f:
            code = f.read()
        self.assertIsNone(re.search(r"models\.Property\s*[).]", code))

    def test_job_segment_is_code_and_name_in_one_safe_folder_name(self):
        self.assertEqual(storage.job_segment("Phase 2 / Canopy", "GSVC-2026-04"), SEG)
        self.assertEqual(storage.job_segment("Barn Roof", "", "p4abcdef-1234"), "p4abcdef - Barn Roof")
        self.assertEqual(storage.job_segment("  ", "GSVC-1"), "GSVC-1")
        self.assertEqual(storage.job_segment("", "", ""), "Job")

    # ── the sweep, end to end ────────────────────────────────────────────────
    def test_the_sweep_files_a_property_job_photo_in_the_property_folder(self):
        m = models.ConstructionMedia(
            id="m1", project_id="p1", daily_log_id="l1", kind="photo",
            url="https://proj.supabase.co/storage/v1/object/public/construction-media/construction/p1/m1.jpg",
            mime_type="image/jpeg", uploaded_by="sagar.shoundik@greensglobal.com",
            uploaded_at=_iso(), taken_at="2026-08-04T09:13:22Z", description="Formwork",
            egnyte_status="pending")
        self.db.add(m)
        self.db.commit()
        made, sent = [], []
        with mock.patch.object(egnyte_svc, "find_property_folder", return_value=FOUND), \
             mock.patch.object(storage, "fetch_url", return_value="https://signed.example/m1"), \
             mock.patch.object(worker.httpx, "Client", _Client), \
             mock.patch.object(egnyte_svc, "create_folder", side_effect=lambda p: made.append(p)), \
             mock.patch.object(egnyte_svc, "upload_file", side_effect=lambda p, raw: sent.append(p)), \
             mock.patch.object(egnyte_svc, "web_url", side_effect=lambda p: f"https://greens.egnyte.com{p}"):
            worker._file_one(self.db, m)
        want = f"{PROP_FOLDER}/Construction/{SEG}/Daily Logs/2026-08/2026-08-04"
        self.assertEqual(made, [want])
        self.assertEqual(sent, [f"{want}/sagar.shoundik-0913-formwork.jpg"])
        self.assertEqual(m.egnyte_path, f"{want}/sagar.shoundik-0913-formwork.jpg")
        self.assertEqual(m.egnyte_status, "uploaded")

    # ── the report of files already at the root ──────────────────────────────
    def _uploaded(self, mid, project_id, path, log_id="", deleted=""):
        self.db.add(models.ConstructionMedia(
            id=mid, project_id=project_id, daily_log_id=log_id, kind="photo",
            url="", taken_at="2026-08-04T09:13:22Z", uploaded_at=_iso(), deleted_at=deleted,
            egnyte_status="uploaded", egnyte_path=path, egnyte_web_url=f"https://e{path}",
            egnyte_synced_at=_iso()))

    def _report(self, found=FOUND, user=MANAGER, jobs=None):
        with mock.patch.dict(os.environ, EGNYTE_ON), \
             mock.patch.object(egnyte_svc, "find_property_folder", return_value=found), \
             mock.patch.object(egnyte_svc, "move_item", _forbidden), \
             mock.patch.object(egnyte_svc, "copy_item", _forbidden), \
             mock.patch.object(egnyte_svc, "delete_item", _forbidden), \
             mock.patch.object(egnyte_svc, "upload_file", _forbidden), \
             mock.patch.object(egnyte_svc, "create_folder", _forbidden):
            return worker.root_filed_report(self.db, jobs or self.db.query(models.ConstructionProject).all(), user)

    def test_the_report_lists_root_files_with_their_destination_and_moves_nothing(self):
        at_root = f"{ROOT}/Phase 2 / Canopy/Construction/Daily Logs/2026-08/2026-08-04/a-0913-photo.jpg"
        at_home = f"{PROP_FOLDER}/Construction/{SEG}/Daily Logs/2026-08/2026-08-04/b.jpg"
        no_prop = f"{ROOT}/Yard Fence/Construction/Daily Logs/2026-08/2026-08-04/c.jpg"
        self._uploaded("r1", "p1", at_root, log_id="l1")
        self._uploaded("r2", "p1", at_home, log_id="l1")
        self._uploaded("r3", "p2", no_prop)
        self.db.commit()
        before = {r.id: (r.egnyte_path, r.egnyte_status) for r in self.db.query(models.ConstructionMedia).all()}
        out = self._report()
        self.assertEqual(out["total"], 1)
        row = out["rows"][0]
        self.assertEqual((row["mediaId"], row["currentPath"]), ("r1", at_root))
        dest = f"{PROP_FOLDER}/Construction/{SEG}/Daily Logs/2026-08/2026-08-04"
        self.assertEqual(row["destinationFolder"], dest)
        self.assertEqual(row["destinationPath"], f"{dest}/a-0913-photo.jpg")
        self.assertEqual(row["propertyName"], "Valley Center")
        self.db.expire_all()
        after = {r.id: (r.egnyte_path, r.egnyte_status) for r in self.db.query(models.ConstructionMedia).all()}
        self.assertEqual(before, after)   # nothing changed, nothing went away

    def test_the_report_names_why_a_property_has_no_destination(self):
        self._uploaded("r1", "p1", f"{ROOT}/Phase 2 / Canopy/x.jpg", log_id="l1")
        self.db.commit()
        out = self._report(found=(None, "ambiguous"), jobs=[self.p1])
        self.assertEqual(out["rows"][0]["destinationFolder"], "")
        self.assertIn("More than one", out["rows"][0]["reason"])

    def test_the_report_leaves_out_deleted_and_other_peoples_drafts(self):
        self._uploaded("gone", "p1", f"{ROOT}/x/gone.jpg", log_id="l1", deleted=_iso())
        self._uploaded("draft", "p1", f"{ROOT}/x/draft.jpg", log_id="ld")
        self.p3.deleted_at = _iso()
        self._uploaded("deadjob", "p3", f"{ROOT}/Gone/y.jpg")
        self.db.commit()
        self.assertEqual(self._report()["rows"], [])
        # The draft's own author sees it.
        mine = self._report(user={"email": "w@greensglobal.com", "level": 3})
        self.assertEqual([r["mediaId"] for r in mine["rows"]], ["draft"])

    def test_a_private_propertys_name_and_folder_are_blanked(self):
        self._uploaded("s1", "p4abcdef-1234", f"{ROOT}/Barn Roof/s.jpg")
        self.db.commit()
        hidden = self._report(found=("/Shared/#Entities/Hidden Ranch", "matched"), jobs=[self.p4])["rows"][0]
        self.assertEqual((hidden["propertyName"], hidden["destinationFolder"], hidden["destinationPath"]),
                         ("", "", ""))
        worker._FOLDER_MEMO.clear()
        owner = self._report(found=("/Shared/#Entities/Hidden Ranch", "matched"), jobs=[self.p4],
                             user={"email": "o@greensglobal.com", "level": 5})["rows"][0]
        self.assertEqual(owner["propertyName"], "Hidden Ranch")
        self.assertTrue(owner["destinationFolder"].startswith("/Shared/#Entities/Hidden Ranch/Construction/"))

    def test_the_report_route_is_managers_only_and_inside_the_walls(self):
        from fastapi import HTTPException
        from routers import construction as rc
        with self.assertRaises(HTTPException) as e:
            rc.egnyte_root_filed(limit=10, user={"email": "w@greensglobal.com", "level": 2}, db=self.db)
        self.assertEqual(e.exception.status_code, 403)
        self.p1.company_id = "c1"
        self.db.commit()
        seen = {}

        def capture(db, jobs, user, limit):
            seen["jobs"] = [j.id for j in jobs]
            return {}
        with mock.patch.object(rc.auth, "company_scope", return_value={"c2"}), \
             mock.patch.object(worker, "root_filed_report", side_effect=capture):
            rc.egnyte_root_filed(limit=10, user=MANAGER, db=self.db)
        self.assertEqual(seen["jobs"], [])   # p1 is company c1; the others have no company


class FindPropertyFolderTests(unittest.TestCase):
    """The UNATTENDED resolver the sweep uses - no loose guesses."""

    def _run(self, roots, site):
        def listing(root):
            got = roots[root]
            if isinstance(got, int):
                raise egnyte_svc.EgnyteError("x", got)
            return {"folders": [{"name": n} for n in got]}
        with mock.patch.object(egnyte_svc, "property_roots", return_value=list(roots)), \
             mock.patch.object(egnyte_svc, "list_folder", side_effect=listing):
            return egnyte_svc.find_property_folder(site)

    def test_exact_and_site_key_matches_win_in_root_order(self):
        roots = {"/e": ["Greens Escondido, LLC", "Other"], "/a": ["Escondido"]}
        self.assertEqual(self._run(roots, "Escondido"), ("/e/Greens Escondido, LLC", "matched"))
        self.assertEqual(self._run({"/e": ["Greens Valley Center, LLC", "Valley Center Inv 1, LLC"]},
                                   "Greens Valley Center"), ("/e/Greens Valley Center, LLC", "matched"))

    def test_a_unique_substring_match_is_taken(self):
        self.assertEqual(self._run({"/e": ["918 El Camino Real Holdings"], "/a": []}, "918 El Camino"),
                         ("/e/918 El Camino Real Holdings", "matched"))

    def test_two_substring_candidates_are_ambiguous_never_a_pick(self):
        roots = {"/e": ["Oak Park North, LLC"], "/a": ["GS Oak Park South"]}
        self.assertEqual(self._run(roots, "Oak Park"), (None, "ambiguous"))

    def test_nothing_is_no_match(self):
        self.assertEqual(self._run({"/e": ["Other"]}, "Valley Center"), (None, "no_match"))

    def test_an_earlier_root_failing_raises_instead_of_a_lower_root_winning(self):
        with self.assertRaises(egnyte_svc.EgnyteError) as e:
            self._run({"/e": 502, "/a": ["GS Valley Center"]}, "Valley Center")
        self.assertEqual(e.exception.status, 502)
        with self.assertRaises(egnyte_svc.EgnyteError):
            self._run({"/e": 403, "/a": ["Valley Center"]}, "Valley Center")

    def test_a_later_root_failing_raises_for_a_substring_answer(self):
        with self.assertRaises(egnyte_svc.EgnyteError):
            self._run({"/e": ["918 El Camino Real"], "/a": 502}, "918 El Camino")

    def test_a_missing_root_is_skipped(self):
        self.assertEqual(self._run({"/e": 404, "/a": ["GS Valley Center"]}, "Valley Center"),
                         ("/a/GS Valley Center", "matched"))
        self.assertEqual(self._run({"/e": 404, "/a": 404}, "Valley Center"), (None, "no_match"))

    def test_the_interactive_resolver_is_unchanged(self):
        def listing(root):
            raise egnyte_svc.EgnyteError("x", 502)
        with mock.patch.object(egnyte_svc, "property_roots", return_value=["/a"]), \
             mock.patch.object(egnyte_svc, "list_folder", side_effect=listing):
            self.assertIsNone(egnyte_svc.resolve_property_folder("Valley Center"))


if __name__ == "__main__":
    unittest.main()
