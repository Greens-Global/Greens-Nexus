"""A property may PIN its exact Egnyte folder (Neil, 11/03/2026: "Should a
property be able to pin its exact Egnyte folder instead of matching by name?"
- yes).

  * the construction filer uses the pinned folder FIRST (why 'pinned') and
    never asks the name match; a blank pin falls back to the name match
    exactly as before;
  * a pinned folder Egnyte answers 404 for is 'pinned_missing': nothing is
    filed - not by name, not at the construction root. The sweep HOLDS the
    file (no attempt spent) and puts it back in the queue once the folder is
    back or the pin changes; a pin outside the roots holds the same way;
  * the root-filed report says how each destination was found (Pinned /
    Matched by Name) and counts the held files;
  * the row save (POST /property-assets/changes) checks a CHANGED pin: a path
    inside the configured property roots, normalized, no '..' - refused per
    row otherwise; blank unpins; a row without the key keeps its pin; an
    unchanged value is not re-checked; no Egnyte call, so it saves with
    Egnyte not set up;
  * who may set it: whoever may edit the asset - the same guard (a private
    asset stays an officer's, scope rows narrow); Find Folder is editors
    only, 404 outside their reach, lists candidates when the name is
    ambiguous and explains when Egnyte is not set up.

Throwaway sqlite file; Egnyte is mocked, never called.
Run with: python -m pytest test_property_egnyte_pin.py   (one file per process)
"""
import os
import tempfile
import unittest
import uuid
from unittest import mock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["EGNYTE_CONSTRUCTION_ROOT"] = "/Shared/Construction"
os.environ.pop("SUPABASE_URL", None)
for _v in ("EGNYTE_PROPERTIES_ROOTS", "EGNYTE_PROPERTIES_ROOT", "EGNYTE_CREATE_ROOT"):
    os.environ.pop(_v, None)

from fastapi import HTTPException  # noqa: E402

import cache  # noqa: E402
import construction_worker as worker  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from routers import property_assets as PA  # noqa: E402
from services import construction_storage as storage  # noqa: E402
from services import egnyte as egnyte_svc  # noqa: E402

PINNED = "/Shared/--Asset Management/GS Valley Center"
MATCHED = "/Shared/#Entities/Greens Valley Center, LLC"
ROOT = "/Shared/Construction"
SEG = "GSVC-2026-04 - Canopy"
EGNYTE_ON = {"EGNYTE_DOMAIN": "greens.egnyte.com", "EGNYTE_TOKEN": "t"}
MANAGER = {"email": "m@greensglobal.com", "level": 3}
EDITOR = {"email": "ed@greensglobal.com", "role": "employee", "level": 2}
OFFICER = {"email": "neil@greensglobal.com", "role": "owner", "level": 5}


def _iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _missing(*a, **k):
    raise egnyte_svc.EgnyteError("Could not browse Egnyte: not found", 404)


def _no_egnyte(*a, **k):
    raise AssertionError("Egnyte must not be called here")


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


def _listing(folders):
    """A list_folder stand-in: {root: [folder names]}; anything else 404."""
    def run(path, token=None):
        p = egnyte_svc.norm(path)
        if p in folders:
            return {"path": p, "folders": [{"name": n, "path": f"{p}/{n}"} for n in folders[p]], "files": []}
        raise egnyte_svc.EgnyteError("Could not browse Egnyte: not found", 404)
    return run


class _Base(unittest.TestCase):
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
        worker._FOLDER_MEMO.clear()
        cache.egnyte_wirings.invalidate()
        self.db = database.SessionLocal()
        for M in (models.ConstructionMedia, models.ConstructionDailyLog, models.ConstructionProject,
                  models.ConstructionAIJob, models.PropertyAsset, models.PropertyRecord,
                  models.PropertyActivityLog, models.PropertyWorkspaceMeta, models.NexusAccessScope):
            self.db.query(M).delete()
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _asset(self, pid="vc", name="Valley Center", rev="r0", **payload):
        payload = {"id": pid, "name": name, "kind": "property", **payload}
        self.db.add(models.PropertyAsset(id=pid, name=name, payload=payload, updated_at=rev))
        self.db.commit()

    def _pin(self, pid):
        self.db.expire_all()
        return (self.db.get(models.PropertyAsset, pid).payload or {}).get("egnyteFolder")


# ── the filer ────────────────────────────────────────────────────────────────
class FilerTests(_Base):
    def setUp(self):
        super().setUp()
        self.db.add(models.ConstructionProject(id="p1", name="Canopy", code="GSVC-2026-04",
                                               property_id="vc", created_at=_iso()))
        self.db.add(models.ConstructionDailyLog(id="l1", project_id="p1", log_date="2026-08-04",
                                                author_email="w@greensglobal.com", status="submitted"))
        self.db.commit()
        self.p1 = self.db.get(models.ConstructionProject, "p1")

    def test_pinned_wins_over_the_name_match(self):
        self._asset(egnyteFolder=PINNED)
        with mock.patch.object(egnyte_svc, "list_folder", _listing({PINNED: []})), \
             mock.patch.object(egnyte_svc, "find_property_folder", _no_egnyte):
            self.assertEqual(worker.property_folder(self.db, self.p1), (PINNED, "pinned"))
            folder = worker.media_folder(self.db, self.p1, "2026-08-04")
        self.assertEqual(folder, f"{PINNED}/Construction/{SEG}/Daily Logs/2026-08/2026-08-04")

    def test_blank_pin_falls_back_to_the_name_match(self):
        self._asset(egnyteFolder="  ")
        with mock.patch.object(egnyte_svc, "list_folder", _no_egnyte), \
             mock.patch.object(egnyte_svc, "find_property_folder", return_value=(MATCHED, "matched")) as r:
            self.assertEqual(worker.property_folder(self.db, self.p1), (MATCHED, "matched"))
        r.assert_called_once_with("Valley Center")

    def test_pinned_missing_does_not_guess_and_does_not_file(self):
        self._asset(egnyteFolder=PINNED)
        with mock.patch.object(egnyte_svc, "list_folder", _missing), \
             mock.patch.object(egnyte_svc, "find_property_folder", _no_egnyte):
            self.assertEqual(worker.property_folder(self.db, self.p1), ("", "pinned_missing"))
            with self.assertRaises(worker.PinnedFolderMissing) as e:
                worker.media_folder(self.db, self.p1, "2026-08-04")
        self.assertIn(PINNED, str(e.exception))

    def test_a_pin_outside_the_roots_holds_too(self):
        self._asset(egnyteFolder="/Private/Somewhere")
        with mock.patch.object(egnyte_svc, "list_folder", _no_egnyte), \
             mock.patch.object(egnyte_svc, "find_property_folder", _no_egnyte):
            self.assertEqual(worker.property_folder(self.db, self.p1), ("", "pinned_invalid"))
            with self.assertRaises(worker.PinnedFolderMissing):
                worker.media_folder(self.db, self.p1, "2026-08-04")

    def test_egnyte_not_answering_on_a_pin_raises_never_guesses(self):
        self._asset(egnyteFolder=PINNED)
        boom = egnyte_svc.EgnyteError("upstream", 502)
        with mock.patch.object(egnyte_svc, "list_folder", side_effect=boom) as lf, \
             mock.patch.object(egnyte_svc, "find_property_folder", _no_egnyte):
            for _ in range(2):
                with self.assertRaises(egnyte_svc.EgnyteError):
                    worker.media_folder(self.db, self.p1, "2026-08-04")
        self.assertEqual(lf.call_count, 1)   # remembered for the tick

    def _pending(self, mid="m1"):
        self.db.add(models.ConstructionMedia(
            id=mid, project_id="p1", daily_log_id="l1", kind="photo",
            url="https://proj.supabase.co/storage/v1/object/public/construction-media/construction/p1/m1.jpg",
            mime_type="image/jpeg", uploaded_by="sagar.shoundik@greensglobal.com",
            uploaded_at=_iso(), taken_at="2026-08-04T09:13:22Z", description="Formwork",
            egnyte_status="pending"))
        self.db.commit()

    def _sweep(self, listing, sent):
        with mock.patch.dict(os.environ, EGNYTE_ON), \
             mock.patch.object(egnyte_svc, "list_folder", listing), \
             mock.patch.object(egnyte_svc, "find_property_folder", _no_egnyte), \
             mock.patch.object(storage, "fetch_url", return_value="https://signed.example/m1"), \
             mock.patch.object(worker.httpx, "Client", _Client), \
             mock.patch.object(egnyte_svc, "create_folder", side_effect=lambda p: sent.append(("mkdir", p))), \
             mock.patch.object(egnyte_svc, "upload_file", side_effect=lambda p, raw: sent.append(("put", p))), \
             mock.patch.object(egnyte_svc, "web_url", side_effect=lambda p: f"https://greens.egnyte.com{p}"):
            return worker.sweep_once()

    def test_the_sweep_holds_a_file_for_a_missing_pin_then_files_it_when_back(self):
        self._asset(egnyteFolder=PINNED)
        self._pending()
        sent = []
        counts = self._sweep(_missing, sent)
        self.assertEqual((counts["held"], counts["filed"], counts["dead"], counts["failed"]), (1, 0, 0, 0))
        self.assertEqual(sent, [])                       # nothing filed anywhere
        self.db.expire_all()
        m = self.db.get(models.ConstructionMedia, "m1")
        self.assertEqual(m.egnyte_status, "held")
        self.assertIn("pinned Egnyte folder", m.egnyte_error)
        # Still missing next tick: still held, still nothing sent.
        self.assertEqual(self._sweep(_missing, sent)["released"], 0)
        self.assertEqual(sent, [])
        # The folder is back: released and filed under the PINNED folder.
        worker._FOLDER_MEMO.clear()
        counts = self._sweep(_listing({PINNED: []}), sent)
        self.assertEqual((counts["released"], counts["filed"]), (1, 1))
        want = f"{PINNED}/Construction/{SEG}/Daily Logs/2026-08/2026-08-04"
        self.assertEqual(sent, [("mkdir", want), ("put", f"{want}/sagar.shoundik-0913-formwork.jpg")])
        self.db.expire_all()
        self.assertEqual(self.db.get(models.ConstructionMedia, "m1").egnyte_status, "uploaded")

    def test_a_cleared_pin_releases_held_files_to_the_name_match(self):
        self._asset(egnyteFolder=PINNED)
        self._pending()
        sent = []
        self._sweep(_missing, sent)
        a = self.db.get(models.PropertyAsset, "vc")
        a.payload = {**a.payload, "egnyteFolder": ""}
        self.db.commit()
        with mock.patch.dict(os.environ, EGNYTE_ON), \
             mock.patch.object(egnyte_svc, "find_property_folder", return_value=(MATCHED, "matched")), \
             mock.patch.object(storage, "fetch_url", return_value="https://signed.example/m1"), \
             mock.patch.object(worker.httpx, "Client", _Client), \
             mock.patch.object(egnyte_svc, "create_folder", side_effect=lambda p: sent.append(("mkdir", p))), \
             mock.patch.object(egnyte_svc, "upload_file", side_effect=lambda p, raw: sent.append(("put", p))), \
             mock.patch.object(egnyte_svc, "web_url", side_effect=lambda p: p):
            counts = worker.sweep_once()
        self.assertEqual((counts["released"], counts["filed"]), (1, 1))
        self.assertTrue(sent[-1][1].startswith(f"{MATCHED}/Construction/"))

    # ── the report ──
    def _report(self, listing, find=(MATCHED, "matched")):
        with mock.patch.dict(os.environ, EGNYTE_ON), \
             mock.patch.object(egnyte_svc, "list_folder", listing), \
             mock.patch.object(egnyte_svc, "find_property_folder", return_value=find):
            return worker.root_filed_report(self.db, [self.p1], MANAGER)

    def _uploaded(self, mid, path):
        self.db.add(models.ConstructionMedia(
            id=mid, project_id="p1", daily_log_id="l1", kind="photo", url="",
            taken_at="2026-08-04T09:13:22Z", uploaded_at=_iso(), egnyte_status="uploaded",
            egnyte_path=path, egnyte_web_url=f"https://e{path}", egnyte_synced_at=_iso()))
        self.db.commit()

    def test_the_report_says_pinned_or_matched_by_name(self):
        self._uploaded("r1", f"{ROOT}/Canopy/Construction/Daily Logs/2026-08/2026-08-04/a.jpg")
        self._asset(egnyteFolder=PINNED)
        row = self._report(_listing({PINNED: []}))["rows"][0]
        self.assertEqual(row["folderSource"], "Pinned")
        self.assertTrue(row["destinationFolder"].startswith(f"{PINNED}/Construction/"))
        worker._FOLDER_MEMO.clear()
        a = self.db.get(models.PropertyAsset, "vc")
        a.payload = {**a.payload, "egnyteFolder": ""}
        self.db.commit()
        row = self._report(_no_egnyte)["rows"][0]
        self.assertEqual(row["folderSource"], "Matched by Name")
        self.assertTrue(row["destinationFolder"].startswith(f"{MATCHED}/Construction/"))

    def test_the_report_names_a_missing_pin_and_counts_held_files(self):
        self._uploaded("r1", f"{ROOT}/Canopy/x.jpg")
        self.db.add(models.ConstructionMedia(id="h1", project_id="p1", kind="photo", url="",
                                             uploaded_at=_iso(), egnyte_status="held"))
        self.db.commit()
        self._asset(egnyteFolder=PINNED)
        out = self._report(_missing)
        row = out["rows"][0]
        self.assertEqual((row["destinationFolder"], row["folderSource"]), ("", ""))
        self.assertIn("pinned", row["reason"])
        self.assertEqual(out["held"], 1)


# ── the path rule ────────────────────────────────────────────────────────────
class PathRuleTests(_Base):
    def test_normalized(self):
        n = egnyte_svc.normalize_pinned_folder
        self.assertEqual(n("Shared//--Asset Management/ GS Valley Center /"), PINNED)
        self.assertEqual(n("\\Shared\\#Entities\\Greens Valley Center, LLC"), MATCHED)
        self.assertEqual(n("/shared/#entities/Greens X"), "/shared/#entities/Greens X")   # Egnyte ignores case
        self.assertEqual(n("   "), "")
        link = "https://greens.egnyte.com/app/index.do#storage/files/1/Shared/%23Entities/Greens%20Valley%20Center%2C%20LLC"
        self.assertEqual(n(link), MATCHED)

    def test_refused(self):
        n = egnyte_svc.normalize_pinned_folder
        for bad in ("/Shared/#Entities/../Private", "/Shared/#Entities/./x", "/Shared/#Entities",
                    "/Private/Anything", "/Shared/#EntitiesX/y", "/Shared/#Entities/a\x00b",
                    "https://example.com/folder"):
            with self.assertRaises(ValueError, msg=bad):
                n(bad)

    def test_the_configured_roots_decide(self):
        with mock.patch.dict(os.environ, {"EGNYTE_PROPERTIES_ROOTS": "/Shared/Sites"}):
            cache.egnyte_wirings.invalidate()
            self.assertEqual(egnyte_svc.normalize_pinned_folder("/Shared/Sites/Temecula"), "/Shared/Sites/Temecula")
            with self.assertRaises(ValueError):
                egnyte_svc.normalize_pinned_folder(MATCHED)


# ── the row save and who may set it ──────────────────────────────────────────
def changes(*rows):
    return PA.Changes(properties=PA.RowOps(upsert=list(rows)))


class SaveTests(_Base):
    def _save(self, user, *rows):
        with mock.patch.object(egnyte_svc, "list_folder", _no_egnyte):   # the save never asks Egnyte
            out = PA.post_changes(changes(*rows), db=self.db, user=user)
        self.db.expire_all()
        return out

    def test_an_editor_pins_a_folder_stored_normalized(self):
        self._asset()
        out = self._save(EDITOR, {"id": "vc", "name": "Valley Center", "_rev": "r0",
                                  "egnyteFolder": "Shared/--Asset Management/GS Valley Center/"})
        self.assertEqual(out["refused"], [])
        self.assertIn("vc", out["revs"])
        self.assertEqual(self._pin("vc"), PINNED)

    def test_a_bad_path_is_refused_for_that_row_only(self):
        self._asset()
        self._asset("tm", "Temecula")
        out = self._save(EDITOR,
                         {"id": "vc", "name": "Valley Center", "_rev": "r0", "egnyteFolder": "/Shared/#Entities/../HR"},
                         {"id": "tm", "name": "Temecula 2", "_rev": "r0"})
        self.assertEqual([(r["id"], r["status"]) for r in out["refused"]], [("vc", 400)])
        self.assertIn("..", out["refused"][0]["message"])
        self.assertIsNone(self._pin("vc"))
        self.assertEqual(self.db.get(models.PropertyAsset, "tm").name, "Temecula 2")

    def test_outside_the_roots_is_refused(self):
        self._asset()
        out = self._save(EDITOR, {"id": "vc", "name": "Valley Center", "_rev": "r0", "egnyteFolder": "/Private/HR"})
        self.assertEqual(out["refused"][0]["status"], 400)
        self.assertIn("/Shared/#Entities", out["refused"][0]["message"])

    def test_a_row_without_the_key_keeps_its_pin_and_blank_unpins(self):
        self._asset(egnyteFolder=PINNED)
        out = self._save(EDITOR, {"id": "vc", "name": "Renamed", "_rev": "r0"})
        self.assertEqual(self._pin("vc"), PINNED)
        # Connecting is one time (Neil, 11/05/2026): an editor may not unpin,
        # a Super Administrator (or an Asset Management Owner) may.
        rev = out["revs"]["vc"]
        out = self._save(EDITOR, {"id": "vc", "name": "Renamed", "_rev": rev, "egnyteFolder": ""})
        self.assertEqual([(r["id"], r["status"]) for r in out["refused"]], [("vc", 403)])
        self.assertEqual(self._pin("vc"), PINNED)
        out = self._save(OFFICER, {"id": "vc", "name": "Renamed", "_rev": rev, "egnyteFolder": ""})
        self.assertEqual(out["refused"], [])
        self.assertEqual(self._pin("vc"), "")

    def test_an_unchanged_pin_is_not_rechecked(self):
        # Saved under an older roots setting: the rest of the row still saves.
        self._asset(egnyteFolder="/Old Root/Valley Center")
        out = self._save(EDITOR, {"id": "vc", "name": "Renamed", "_rev": "r0", "egnyteFolder": "/Old Root/Valley Center"})
        self.assertEqual(out["refused"], [])
        self.assertEqual(self._pin("vc"), "/Old Root/Valley Center")

    def test_it_saves_with_egnyte_not_set_up(self):
        self._asset()
        with mock.patch.dict(os.environ, {"EGNYTE_DOMAIN": "", "EGNYTE_TOKEN": ""}):
            out = self._save(EDITOR, {"id": "vc", "name": "Valley Center", "_rev": "r0", "egnyteFolder": PINNED})
        self.assertEqual(out["refused"], [])
        self.assertEqual(self._pin("vc"), PINNED)

    def test_a_private_asset_stays_an_officers(self):
        self._asset(private=True)
        with self.assertRaises(HTTPException) as e:
            self._save(EDITOR, {"id": "vc", "name": "Valley Center", "_rev": "r0", "private": True, "egnyteFolder": PINNED})
        self.assertEqual(e.exception.status_code, 403)
        self.db.rollback()
        self.assertIsNone(self._pin("vc"))
        out = self._save(OFFICER, {"id": "vc", "name": "Valley Center", "_rev": "r0", "private": True, "egnyteFolder": PINNED})
        self.assertEqual(out["refused"], [])
        self.assertEqual(self._pin("vc"), PINNED)

    def test_scope_rows_narrow_who_may_pin(self):
        self._asset()
        self._asset("tm", "Temecula")
        self.db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=EDITOR["email"], module_id="property-asset",
                                            scope_type="property", scope_id="tm"))
        self.db.commit()
        cache.module_grants.invalidate()
        with self.assertRaises(HTTPException) as e:
            self._save(EDITOR, {"id": "vc", "name": "Valley Center", "_rev": "r0", "egnyteFolder": PINNED})
        self.assertEqual(e.exception.status_code, 403)

    def test_the_save_and_find_are_for_editors(self):
        def deps(path, method):
            route = next(r for r in PA.router.routes if r.path == path and method in r.methods)
            return [d.call for d in route.dependant.dependencies]
        self.assertIn(PA.require_asset_write, deps("/property-assets/changes", "POST"))
        self.assertIn(PA.require_asset_write, deps("/property-assets/{pid}/egnyte-folders", "GET"))


# ── Find Folder ──────────────────────────────────────────────────────────────
class FindTests(_Base):
    def _find(self, user=EDITOR, pid="vc", q="", listing=None, configured=True):
        with mock.patch.object(egnyte_svc, "configured", return_value=configured), \
             mock.patch.object(egnyte_svc, "list_folder", listing or _no_egnyte):
            return PA.find_egnyte_folders(pid, q=q, db=self.db, user=user)

    def test_not_set_up_explains_and_lists_nothing(self):
        self._asset()
        out = self._find(configured=False)
        self.assertFalse(out["configured"])
        self.assertIn("not set up", out["message"])
        self.assertEqual(out["candidates"], [])
        self.assertIn("/Shared/#Entities", out["roots"])

    def test_an_ambiguous_name_lists_every_candidate_and_picks_none(self):
        self._asset(name="Escondido Storage")
        listing = _listing({"/Shared/#Entities": ["Escondido Storage North", "Escondido Storage South", "Other"],
                            "/Shared/--Asset Management": ["GS Temecula"]})
        out = self._find(listing=listing)
        self.assertEqual(out["why"], "ambiguous")
        self.assertIsNone(out["match"])
        self.assertEqual([c["name"] for c in out["candidates"]], ["Escondido Storage North", "Escondido Storage South"])
        self.assertIn("pick the right one", out["message"])

    def test_the_best_match_leads_and_other_roots_are_listed(self):
        self._asset()
        listing = _listing({"/Shared/#Entities": ["Greens Valley Center, LLC", "Valley Center Inv 1, LLC"],
                            "/Shared/--Asset Management": ["GS Valley Center"]})
        out = self._find(listing=listing)
        self.assertEqual(out["match"], MATCHED)
        self.assertEqual([c["path"] for c in out["candidates"]][:2], [MATCHED, PINNED])
        self.assertEqual(out["candidates"][-1]["how"], "contains")

    def test_a_typed_name_is_the_search_and_the_pin_is_checked(self):
        self._asset(egnyteFolder=PINNED)
        listing = _listing({"/Shared/#Entities": ["Greens Escondido, LLC"]})
        out = self._find(q="Escondido", listing=listing)
        self.assertEqual((out["site"], out["match"]), ("Escondido", "/Shared/#Entities/Greens Escondido, LLC"))
        self.assertIs(out["pinnedFound"], False)

    def test_egnyte_down_is_an_answer_not_a_500(self):
        self._asset()
        out = self._find(listing=mock.Mock(side_effect=egnyte_svc.EgnyteError("upstream", 502)))
        self.assertIn("did not answer", out["error"])

    def test_outside_reach_is_404(self):
        self._asset(private=True)
        with self.assertRaises(HTTPException) as e:
            self._find(EDITOR)
        self.assertEqual(e.exception.status_code, 404)
        self.assertTrue(self._find(OFFICER, configured=False)["roots"])
        with self.assertRaises(HTTPException) as e:
            self._find(EDITOR, pid="nope")
        self.assertEqual(e.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
