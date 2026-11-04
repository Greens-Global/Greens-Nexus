"""Construction files go to the PROPERTY's Egnyte folder (Neil, 11/03/2026).

Until 11/03/2026 the sweep looked a job's property up in `models.Property`,
which does not exist, so every photo, video and voice note since August went
to the construction root. Now a job with a property files under
`<property folder>/Construction/<job>/Daily Logs/YYYY-MM/YYYY-MM-DD/`; a job
without one, or whose property has no Egnyte folder, keeps the root (logged).
Files already at the root stay there: the report lists them, nothing moves.

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
        self.db.add(models.PropertyAsset(id="no-name", name=""))
        self.db.add(models.ConstructionProject(id="p1", name="Phase 2 / Canopy", code="GSVC-2026-04",
                                               property_id="greens-valley-center", created_at=_iso()))
        self.db.add(models.ConstructionProject(id="p2", name="Yard Fence", created_at=_iso()))
        self.db.add(models.ConstructionProject(id="p3", name="Gone", property_id="not-in-asset-mgmt",
                                               created_at=_iso()))
        self.db.add(models.ConstructionDailyLog(id="l1", project_id="p1", log_date="2026-08-04",
                                                author_email="w@greensglobal.com", status="submitted"))
        self.db.commit()
        self.p1 = self.db.get(models.ConstructionProject, "p1")
        self.p2 = self.db.get(models.ConstructionProject, "p2")
        self.p3 = self.db.get(models.ConstructionProject, "p3")

    def tearDown(self):
        self.db.close()

    # ── the path ─────────────────────────────────────────────────────────────
    def test_a_property_job_files_under_the_propertys_own_folder(self):
        with mock.patch.object(egnyte_svc, "resolve_property_folder", return_value=PROP_FOLDER) as r:
            folder = worker.media_folder(self.db, self.p1, "2026-08-04")
        self.assertEqual(folder, f"{PROP_FOLDER}/Construction/Phase 2 Canopy/Daily Logs/2026-08/2026-08-04")
        # Found by the Asset Management property's name, strictly (Egnyte not
        # answering must not read as "no folder").
        r.assert_called_once_with("Valley Center", strict=True)

    def test_no_folder_for_the_property_falls_back_to_the_construction_root(self):
        with mock.patch.object(egnyte_svc, "resolve_property_folder", return_value=None):
            folder = worker.media_folder(self.db, self.p1, "2026-08-04")
        self.assertEqual(folder, f"{ROOT}/Phase 2 / Canopy/Construction/Daily Logs/2026-08/2026-08-04")
        self.assertEqual(worker.property_folder(self.db, self.p1), ("", "no_egnyte_folder"))

    def test_a_job_without_a_property_keeps_the_root_and_never_searches(self):
        with mock.patch.object(egnyte_svc, "resolve_property_folder") as r:
            folder = worker.media_folder(self.db, self.p2, "2026-08-04")
        self.assertEqual(folder, f"{ROOT}/Yard Fence/Construction/Daily Logs/2026-08/2026-08-04")
        r.assert_not_called()

    def test_a_property_missing_from_asset_management_keeps_the_root(self):
        with mock.patch.object(egnyte_svc, "resolve_property_folder") as r:
            folder = worker.media_folder(self.db, self.p3, "2026-08-04")
        self.assertTrue(folder.startswith(f"{ROOT}/Gone/"))
        r.assert_not_called()
        self.assertEqual(worker.property_folder(self.db, self.p3)[1], "property_missing")

    def test_egnyte_not_answering_raises_so_the_row_is_retried(self):
        boom = egnyte_svc.EgnyteError("upstream", 502)
        with mock.patch.object(egnyte_svc, "resolve_property_folder", side_effect=boom):
            with self.assertRaises(egnyte_svc.EgnyteError):
                worker.media_folder(self.db, self.p1, "2026-08-04")

    def test_one_lookup_per_property_per_tick(self):
        with mock.patch.object(egnyte_svc, "resolve_property_folder", return_value=PROP_FOLDER) as r:
            worker.media_folder(self.db, self.p1, "2026-08-04")
            worker.media_folder(self.db, self.p1, "2026-08-05")
        self.assertEqual(r.call_count, 1)

    def test_the_models_property_bug_is_gone(self):
        self.assertFalse(hasattr(models, "Property"))
        with open(os.path.join(HERE, "construction_worker.py"), encoding="utf-8") as f:
            code = "\n".join(line for line in f if not line.lstrip().startswith(("#", "(", "`")))
        self.assertIsNone(re.search(r"models\.Property\b(?!Asset)\s*[).]", code))

    def test_job_segment_is_one_safe_folder_name(self):
        self.assertEqual(storage.job_segment("Phase 2 / Canopy"), "Phase 2 Canopy")
        self.assertEqual(storage.job_segment("  ", "GSVC-1"), "GSVC-1")
        self.assertEqual(storage.job_segment("", "", "abc"), "abc")

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
        with mock.patch.object(egnyte_svc, "resolve_property_folder", return_value=PROP_FOLDER), \
             mock.patch.object(storage, "fetch_url", return_value="https://signed.example/m1"), \
             mock.patch.object(worker.httpx, "Client", _Client), \
             mock.patch.object(egnyte_svc, "create_folder", side_effect=lambda p: made.append(p)), \
             mock.patch.object(egnyte_svc, "upload_file", side_effect=lambda p, raw: sent.append(p)), \
             mock.patch.object(egnyte_svc, "web_url", side_effect=lambda p: f"https://greens.egnyte.com{p}"):
            worker._file_one(self.db, m)
        want = f"{PROP_FOLDER}/Construction/Phase 2 Canopy/Daily Logs/2026-08/2026-08-04"
        self.assertEqual(made, [want])
        self.assertEqual(sent, [f"{want}/sagar.shoundik-0913-formwork.jpg"])
        self.assertEqual(m.egnyte_path, f"{want}/sagar.shoundik-0913-formwork.jpg")
        self.assertEqual(m.egnyte_status, "uploaded")

    # ── the report of files already at the root ──────────────────────────────
    def _uploaded(self, mid, project_id, path, log_id=""):
        self.db.add(models.ConstructionMedia(
            id=mid, project_id=project_id, daily_log_id=log_id, kind="photo",
            url="", taken_at="2026-08-04T09:13:22Z", uploaded_at=_iso(),
            egnyte_status="uploaded", egnyte_path=path, egnyte_web_url=f"https://e{path}"))

    def test_the_report_lists_root_files_with_their_destination_and_moves_nothing(self):
        at_root = f"{ROOT}/Phase 2 / Canopy/Construction/Daily Logs/2026-08/2026-08-04/a-0913-photo.jpg"
        at_home = f"{PROP_FOLDER}/Construction/Phase 2 Canopy/Daily Logs/2026-08/2026-08-04/b.jpg"
        no_prop = f"{ROOT}/Yard Fence/Construction/Daily Logs/2026-08/2026-08-04/c.jpg"
        self._uploaded("r1", "p1", at_root, log_id="l1")
        self._uploaded("r2", "p1", at_home, log_id="l1")
        self._uploaded("r3", "p2", no_prop)
        self.db.commit()
        before = {r.id: (r.egnyte_path, r.egnyte_status) for r in self.db.query(models.ConstructionMedia).all()}
        jobs = self.db.query(models.ConstructionProject).all()
        with mock.patch.dict(os.environ, {"EGNYTE_DOMAIN": "greens.egnyte.com", "EGNYTE_TOKEN": "t"}), \
             mock.patch.object(egnyte_svc, "resolve_property_folder", return_value=PROP_FOLDER), \
             mock.patch.object(egnyte_svc, "move_item", _forbidden), \
             mock.patch.object(egnyte_svc, "copy_item", _forbidden), \
             mock.patch.object(egnyte_svc, "delete_item", _forbidden), \
             mock.patch.object(egnyte_svc, "upload_file", _forbidden), \
             mock.patch.object(egnyte_svc, "create_folder", _forbidden):
            out = worker.root_filed_report(self.db, jobs)
        self.assertEqual(out["total"], 1)
        row = out["rows"][0]
        self.assertEqual((row["mediaId"], row["currentPath"]), ("r1", at_root))
        dest = f"{PROP_FOLDER}/Construction/Phase 2 Canopy/Daily Logs/2026-08/2026-08-04"
        self.assertEqual(row["destinationFolder"], dest)
        self.assertEqual(row["destinationPath"], f"{dest}/a-0913-photo.jpg")
        self.assertEqual(row["propertyName"], "Valley Center")
        # Nothing changed and nothing went away.
        self.db.expire_all()
        after = {r.id: (r.egnyte_path, r.egnyte_status) for r in self.db.query(models.ConstructionMedia).all()}
        self.assertEqual(before, after)

    def test_the_report_names_why_a_property_has_no_destination(self):
        self._uploaded("r1", "p1", f"{ROOT}/Phase 2 / Canopy/x.jpg", log_id="l1")
        self.db.commit()
        with mock.patch.dict(os.environ, {"EGNYTE_DOMAIN": "greens.egnyte.com", "EGNYTE_TOKEN": "t"}), \
             mock.patch.object(egnyte_svc, "resolve_property_folder", return_value=None):
            out = worker.root_filed_report(self.db, [self.p1])
        self.assertEqual(out["rows"][0]["destinationFolder"], "")
        self.assertIn("No Egnyte folder", out["rows"][0]["reason"])

    def test_the_report_route_is_managers_only_and_inside_the_walls(self):
        from fastapi import HTTPException
        from routers import construction as rc
        with self.assertRaises(HTTPException) as e:
            rc.egnyte_root_filed(limit=10, user={"email": "w@greensglobal.com", "level": 2}, db=self.db)
        self.assertEqual(e.exception.status_code, 403)
        self.p1.company_id = "c1"
        self.db.commit()
        seen = {}
        with mock.patch.object(rc.auth, "company_scope", return_value={"c2"}), \
             mock.patch.object(worker, "root_filed_report",
                               side_effect=lambda db, jobs, limit: seen.setdefault("jobs", [j.id for j in jobs]) and {}):
            rc.egnyte_root_filed(limit=10, user={"email": "m@greensglobal.com", "level": 3}, db=self.db)
        self.assertEqual(seen["jobs"], [])   # p1 is company c1, p3 has no company


class StrictResolverTests(unittest.TestCase):
    def _roots(self, statuses):
        errs = iter(statuses)

        def listing(root):
            raise egnyte_svc.EgnyteError("x", next(errs))
        return listing

    def test_strict_raises_when_no_root_answers(self):
        with mock.patch.object(egnyte_svc, "property_roots", return_value=["/a", "/b"]), \
             mock.patch.object(egnyte_svc, "list_folder", side_effect=self._roots([502, 404])):
            with self.assertRaises(egnyte_svc.EgnyteError) as e:
                egnyte_svc.resolve_property_folder("Valley Center", strict=True)
        self.assertEqual(e.exception.status, 502)

    def test_missing_roots_are_not_an_outage(self):
        with mock.patch.object(egnyte_svc, "property_roots", return_value=["/a", "/b"]), \
             mock.patch.object(egnyte_svc, "list_folder", side_effect=self._roots([404, 404])):
            self.assertIsNone(egnyte_svc.resolve_property_folder("Valley Center", strict=True))

    def test_not_strict_keeps_the_old_answer(self):
        with mock.patch.object(egnyte_svc, "property_roots", return_value=["/a"]), \
             mock.patch.object(egnyte_svc, "list_folder", side_effect=self._roots([502])):
            self.assertIsNone(egnyte_svc.resolve_property_folder("Valley Center"))

    def test_one_root_answering_is_trusted(self):
        def listing(root):
            if root == "/a":
                raise egnyte_svc.EgnyteError("x", 502)
            return {"folders": [{"name": "GS Valley Center"}]}
        with mock.patch.object(egnyte_svc, "property_roots", return_value=["/a", "/b"]), \
             mock.patch.object(egnyte_svc, "list_folder", side_effect=listing):
            self.assertEqual(egnyte_svc.resolve_property_folder("valley center", strict=True),
                             "/b/GS Valley Center")


if __name__ == "__main__":
    unittest.main()
